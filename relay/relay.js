#!/usr/bin/env node
// MPR relay: a dumb, zero-dependency store-and-forward mailbox.
// It never needs to be trusted with content integrity (envelopes are signed end to end);
// it only stops strangers from reading or draining someone else's mailbox.
//
//   POST /v1/register              (signed)  claim a handle → public key (first come, first pinned)
//   POST /v1/inbox/:handle          anyone   deposit a signed envelope (signature checked here too)
//   GET  /v1/inbox/:handle          (signed)  read pending messages
//   POST /v1/ack/:handle/:id        (signed)  delete a delivered message (and record a read receipt)
//   GET  /v1/receipts?ids=&handle=   anyone   when those deposits were read; when handle last checked its mail
//   GET  /healthz
//
// It also works mounted under a path prefix (e.g. behind a proxy at /mpr/...): everything before the
// protocol path is ignored, and signatures cover only the protocol path.
// Hosted twin: relay/supabase/mpr-relay/index.ts (same protocol, Postgres storage).
//
// Env: PORT (default 8787), MPR_RELAY_DATA (default ./relay-data next to this file),
//      MPR_RELAY_MAX_KB (per envelope, default 64), MPR_RELAY_MAX_BOX_KB (per mailbox, default 2048)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyString, verifyObject } from "../src/core/crypto.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.MPR_RELAY_DATA || path.join(here, "relay-data"));
const PORT = Number(process.env.PORT || 8787);
const MAX = Number(process.env.MPR_RELAY_MAX_KB || 64) * 1024;
const MAX_BOX = Number(process.env.MPR_RELAY_MAX_BOX_KB || 2048) * 1024;
const SKEW_MS = 5 * 60 * 1000;
fs.mkdirSync(path.join(DATA, "boxes"), { recursive: true });

const regFile = path.join(DATA, "registry.json");
const registry = () => { try { return JSON.parse(fs.readFileSync(regFile, "utf8")); } catch { return {}; } };
// Handles map to folders: [a-z0-9._-], no leading dots, no "..", so "." / ".." can never reach the data folder itself.
const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 64);
const boxDir = (h) => path.join(DATA, "boxes", norm(h));
const seenNonces = new Map();

function protocolPath(pathname) {
  const m = pathname.match(/\/v1\/(register|inbox|ack|receipts)(\/|$)/);
  return m ? pathname.slice(m.index) : pathname;
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authed(req, pathname, key) {
  const h = req.headers;
  const ts = Number(h["x-mpr-time"]);
  if (!ts || Math.abs(Date.now() - ts) > SKEW_MS) return false;
  const sig = h["x-mpr-sig"];
  if (!sig || seenNonces.has(sig)) return false;
  const nonce = h["x-mpr-nonce"];
  const ok = verifyString(nonce ? `${req.method} ${pathname} ${h["x-mpr-time"]} ${nonce}` : `${req.method} ${pathname} ${h["x-mpr-time"]}`, sig, key);
  if (ok) {
    seenNonces.set(sig, ts);
    if (seenNonces.size > 5000) for (const [k, v] of seenNonces) if (Date.now() - v > SKEW_MS) seenNonces.delete(k);
  }
  return ok;
}

// Read receipts and last check-in, so a waiting AI can tell "read and quiet" from "not running".
const receiptsFile = path.join(DATA, "receipts.json"), pollsFile = path.join(DATA, "polls.json");
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://relay");
    if (url.pathname.endsWith("/healthz")) return send(res, 200, { ok: true });
    const pathname = protocolPath(url.pathname);
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (req.method === "GET" && pathname === "/v1/receipts") {
      const rc = readJ(receiptsFile), polls = readJ(pollsFile);
      const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200);
      const h = norm(url.searchParams.get("handle"));
      return send(res, 200, { read: Object.fromEntries(ids.filter((i) => rc[i]).map((i) => [i, rc[i]])), last_check: h ? polls[h] || null : null });
    }

    if (req.method === "POST" && pathname === "/v1/register") {
      const body = JSON.parse(await readBody(req));
      const handle = norm(body.handle);
      if (!handle || !body.key) return send(res, 400, { error: "handle and key required" });
      if (!authed(req, pathname, body.key)) return send(res, 401, { error: "bad signature" });
      const reg = registry();
      if (reg[handle] && reg[handle] !== body.key) return send(res, 409, { error: "handle already registered to another key" });
      reg[handle] = body.key;
      fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
      fs.mkdirSync(boxDir(handle), { recursive: true });
      return send(res, 200, { ok: true, handle });
    }

    if (parts[0] === "v1" && parts[1] === "inbox" && parts[2]) {
      const handle = norm(parts[2]);
      const key = registry()[handle];
      if (!key) return send(res, 404, { error: "unknown handle" });

      if (req.method === "POST") {
        const env = JSON.parse(await readBody(req));
        if (!env?.from?.key || !verifyObject(env, env.from.key)) return send(res, 400, { error: "envelope signature invalid" });
        if (norm(env?.to?.handle) !== handle) return send(res, 400, { error: "envelope not addressed to this mailbox" });
        const id = crypto.randomBytes(9).toString("base64url");
        const dir = boxDir(handle);
        fs.mkdirSync(dir, { recursive: true });
        const stored = JSON.stringify(env);
        const existing = fs.readdirSync(dir);
        const used = existing.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
        if (existing.length >= 1000 || used + Buffer.byteLength(stored) > MAX_BOX) return send(res, 429, { error: "mailbox full" });
        fs.writeFileSync(path.join(dir, `${Date.now()}_${id}.json`), stored);
        return send(res, 202, { ok: true, id });
      }

      if (req.method === "GET") {
        if (!authed(req, pathname, key)) return send(res, 401, { error: "bad signature" });
        const polls = readJ(pollsFile); polls[handle] = new Date().toISOString(); fs.writeFileSync(pollsFile, JSON.stringify(polls));
        const dir = boxDir(handle);
        const list = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(0, 100) : []);
        // Long-poll: ?wait=N (≤25 s) holds the request until mail arrives.
        const until = Date.now() + Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 25) * 1000;
        let files = list();
        while (!files.length && Date.now() < until) { await new Promise((r) => setTimeout(r, 250)); files = list(); }
        const messages = files.map((f) => ({ id: f.slice(0, -5), envelope: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
        return send(res, 200, { messages });
      }
    }

    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "ack" && parts[2] && parts[3]) {
      const handle = norm(parts[2]);
      const key = registry()[handle];
      if (!key || !authed(req, pathname, key)) return send(res, 401, { error: "bad signature" });
      const file = path.join(boxDir(handle), path.basename(parts[3]) + ".json");
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        const rc = readJ(receiptsFile); rc[String(parts[3]).split("_").slice(1).join("_") || parts[3]] = new Date().toISOString();
        fs.writeFileSync(receiptsFile, JSON.stringify(rc));
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.error(`MPR relay listening on :${PORT} (data: ${DATA})`));
