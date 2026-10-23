// Delivery channels. An envelope is self-authenticating, so transports only move bytes.
//   folder — a directory both agents can reach (same Mac, or a shared Dropbox/iCloud/Drive folder)
//   relay  — a tiny store-and-forward HTTP server (relay/relay.js), self-hosted
//   text   — armored text the human (or a Gmail/iMessage connector) sends; zero install for the other side
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { signString } from "./crypto.js";
import { normHandle } from "./store.js";

export async function deliver(env, contact, { quick = false } = {}) {
  const results = [];
  const t = contact?.transports || {};
  if (t.folder) {
    try {
      const dir = path.join(t.folder, normHandle(contact.handle), "inbox");
      fs.mkdirSync(dir, { recursive: true });
      // Time-prefixed names so the receiver reads messages in the order they were sent.
      const name = `${String(Date.now()).padStart(15, "0")}_${String(env.id).replace(/[^A-Za-z0-9_-]/g, "_")}`;
      const tmp = path.join(dir, `.${name}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(env));
      fs.renameSync(tmp, path.join(dir, `${name}.json`));
      results.push({ via: "folder", ok: true, where: dir });
    } catch (e) {
      results.push({ via: "folder", ok: false, error: e.message });
    }
  }
  if (t.relay) {
    // Transient failures (network, 5xx, rate limit) get two quick retries; anything left is queued by the caller.
    let last;
    for (const delay of quick ? [0] : [0, 600, 2000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await fetch(relayUrl(t.relay, `/v1/inbox/${encodeURIComponent(normHandle(contact.handle))}`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(env),
          signal: AbortSignal.timeout(10000),
        });
        const body = await res.text();
        last = { via: "relay", ok: res.ok, status: res.status, detail: body.slice(0, 200), retryable: res.status >= 500 || res.status === 429 || res.status === 404 };
        // A missing mailbox won't appear in the next two seconds: queue it rather than retrying right away.
        if (res.ok || !last.retryable || res.status === 404) break;
      } catch (e) {
        last = { via: "relay", ok: false, error: e.message, retryable: true };
      }
    }
    results.push(last);
  }
  return results;
}

// Join a protocol path onto the relay base without dropping the base's own path
// (e.g. https://<ref>.supabase.co/functions/v1/mpr-relay). Signatures cover only the protocol path.
export function relayUrl(base, pathname) {
  return new URL(String(base).replace(/\/+$/, "") + pathname);
}

// Ed25519 signatures are deterministic and relays accept each signature once (replay protection), so two signed
// requests in the same millisecond would collide. Timestamps are made strictly increasing per process.
let lastTs = 0;
function relayAuthHeaders(identity, method, pathname) {
  lastTs = Math.max(Date.now(), lastTs + 1);
  const ts = String(lastTs);
  // A random nonce inside the signature makes every request unique, even across processes sharing an identity.
  const nonce = crypto.randomBytes(9).toString("base64url");
  return {
    "x-mpr-handle": identity.handle,
    "x-mpr-time": ts,
    "x-mpr-nonce": nonce,
    "x-mpr-sig": signString(`${method} ${pathname} ${ts} ${nonce}`, identity.privateKey),
  };
}

export async function registerWithRelay(identity) {
  const url = identity.transports?.relay;
  if (!url) return null;
  const pathname = "/v1/register";
  // The relay allows a few registrations a minute per network address (invites count too). When busy, wait and retry
  // for up to about a minute rather than failing.
  let out;
  for (const delay of [0, 8000, 15000, 20000, 20000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const res = await fetch(relayUrl(url, pathname), {
      method: "POST",
      headers: { "content-type": "application/json", ...relayAuthHeaders(identity, "POST", pathname) },
      body: JSON.stringify({ handle: identity.handle, key: identity.publicKey }),
    });
    out = { ok: res.ok, status: res.status, detail: (await res.text()).slice(0, 200) };
    if (res.status !== 429) break;
  }
  return out;
}

/** Pull raw envelopes waiting for us. Returns [{ via, raw, ack() }]. */
export async function collect(identity, { wait = 0 } = {}) {
  const out = [];
  const t = identity.transports || {};
  if (t.folder) {
    const dir = path.join(t.folder, normHandle(identity.handle), "inbox");
    const done = path.join(t.folder, normHandle(identity.handle), "processed");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
        const file = path.join(dir, f);
        let raw;
        try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { raw = { __parse_error: e.message }; }
        out.push({
          via: "folder",
          raw,
          ack: () => { fs.mkdirSync(done, { recursive: true }); fs.renameSync(file, path.join(done, f)); },
        });
      }
    }
  }
  if (t.relay) {
    const pathname = `/v1/inbox/${encodeURIComponent(normHandle(identity.handle))}`;
    try {
      const u = relayUrl(t.relay, pathname);
      if (wait > 0) u.searchParams.set("wait", String(Math.min(wait, 25)));   // long-poll (ignored by older relays)
      const res = await fetch(u, { headers: relayAuthHeaders(identity, "GET", pathname) });
      if (res.ok) {
        const { messages = [] } = await res.json();
        for (const m of messages) {
          out.push({
            via: "relay",
            raw: m.envelope,
            ack: async () => {
              const ap = `/v1/ack/${encodeURIComponent(normHandle(identity.handle))}/${encodeURIComponent(m.id)}`;
              await fetch(relayUrl(t.relay, ap), { method: "POST", headers: relayAuthHeaders(identity, "POST", ap) });
            },
          });
        }
      } else {
        let error = `relay returned ${res.status}: ${(await res.text()).slice(0, 200)}`;
        // Signed requests carry the time; a wrong computer clock looks like "bad signature". Say so plainly.
        if (res.status === 401) {
          const server = Date.parse(res.headers.get("date") || "");
          const skewMin = server ? Math.round((Date.now() - server) / 60000) : 0;
          if (Math.abs(skewMin) >= 4) error = `this computer's clock is off by about ${Math.abs(skewMin)} minutes (${skewMin > 0 ? "ahead" : "behind"}); the relay rejects requests with wrong times. Turn on automatic date & time in your system settings.`;
        }
        out.push({ via: "relay", error });
      }
    } catch (e) {
      out.push({ via: "relay", error: e.message });
    }
  }
  return out;
}

/** When the given deposits were read, and when `handle` last checked its mail (relays from 2.0.4 on). */
export async function fetchReceipts(relay, ids, handle) {
  const q = new URLSearchParams({ ids: ids.join(","), ...(handle ? { handle } : {}) });
  try {
    const res = await fetch(relayUrl(relay, `/v1/receipts?${q}`), { signal: AbortSignal.timeout(10000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
