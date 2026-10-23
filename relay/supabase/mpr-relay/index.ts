// MPR relay as a Supabase Edge Function (Deno). Same wire protocol and auth semantics as relay/relay.js:
//
//   POST /v1/register              (signed)  claim a handle → public key (first come, first pinned)
//   POST /v1/inbox/:handle          anyone   deposit a signed envelope (signature checked here too)
//   GET  /v1/inbox/:handle          (signed)  read pending messages
//   POST /v1/ack/:handle/:id        (signed)  delete a delivered message (and record a read receipt)
//   GET  /v1/receipts?ids=&handle=   anyone   when those deposits were read; when handle last checked its mail
//   GET  /healthz
//
// Public URL: https://<project-ref>.supabase.co/functions/v1/mpr-relay  (deployed with verify_jwt=false:
// this function does its own Ed25519 auth). Storage is the private `mpr` schema (relay/supabase/schema.sql),
// reached over the built-in SUPABASE_DB_URL connection, never through the Data API.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const MAX = 64 * 1024;              // per request body / envelope
const MAX_MSGS = 1000;              // per mailbox
const MAX_BOX_BYTES = 8 * 1024 * 1024; // per mailbox (a sealed 1 MB file is ~1.9 MB)
const MAX_HANDLES = 20000;          // whole relay, durable handles
// Throwaway handles: invite mailboxes ("inv-…", one per invite) and test identities ("mprtest-…").
// They get their own pool and expire (with their messages), so invites can't use up the durable slots.
const EPHEMERAL = /^(inv|mprtest)-/;
const MAX_EPHEMERAL = 20000;
const INV_TTL = "30 days";
const TEST_TTL = "1 day";
// Whole relay: free-tier Postgres (~500 MB), so cap total stored bytes.
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const FETCH_LIMIT = 100;
const SKEW_MS = 5 * 60 * 1000;
const RETENTION = "14 days";        // undelivered messages expire (PRIVACY.md)
// Rate limits per fixed 1-minute window (shared across isolates through Postgres).
const LIMITS: Record<string, number> = { send: 120, read: 240, register: 10, inbox: 300, ip: 600 };
const IDLE_EXPIRY = "180 days";     // durable handles nobody has read for this long can be reclaimed when the relay is full
const VERSION = "2026-10-18b";

async function overLimit(kind: string, who: string): Promise<boolean> {
  const bucket = `${kind}:${who}`;
  const [{ n }] = await db`
    insert into mpr.rate (bucket, win, n) values (${bucket}, date_trunc('minute', now()), 1)
    on conflict (bucket, win) do update set n = mpr.rate.n + 1
    returning n`;
  if (Math.random() < 0.02) await db`delete from mpr.rate where win < now() - interval '10 minutes'`;
  return n > LIMITS[kind];
}
// The address the platform saw, never a client-supplied X-Forwarded-For prefix (that's spoofable).
const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip")
  || (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean).at(-1) || "unknown";

// Every running copy of this function would otherwise hold its own direct database connections, and a burst of
// requests starts many copies, exhausting Postgres (error 53300). Go through Supabase's transaction pooler instead,
// which shares a few connections among all of them. The direct URL is the fallback.
const REGION = "us-west-1";
const DIRECT = Deno.env.get("SUPABASE_DB_URL")!;
function poolerUrls(): string[] {
  const u = new URL(DIRECT);
  const ref = u.hostname.split(".")[1];
  return ["aws-0", "aws-1"].map((p) => `postgresql://postgres.${ref}:${u.password}@${p}-${REGION}.pooler.supabase.com:6543/postgres`);
}
let sqlP: Promise<any> | null = null;
let dbVia = "";
function getSql(): Promise<any> {
  return (sqlP ||= (async () => {
    for (const url of [...poolerUrls(), DIRECT]) {
      const c = postgres(url, { prepare: false, max: 2, idle_timeout: 10, connect_timeout: 5 });
      try { await c`select 1`; dbVia = url === DIRECT ? "direct" : new URL(url).hostname.split(".")[0]; return c; } catch { try { await c.end({ timeout: 1 }); } catch { /* ignore */ } }
    }
    sqlP = null;
    throw new Error("database unreachable");
  })());
}
// A brief connection hiccup gets one quick retry; anything else is a real error.
const TRANSIENT = /CONNECT|ECONN|too many (clients|connections)|53300|57P0|08\d\d\d|timeout|terminat|reset/i;
async function db(strings: TemplateStringsArray, ...vals: unknown[]): Promise<any> {
  for (let i = 0; ; i++) {
    try { const sql = await getSql(); return await sql(strings, ...(vals as any[])); }
    catch (e) {
      if (i >= 1 || !TRANSIENT.test(`${(e as any)?.code} ${(e as Error)?.message}`)) throw e;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
    }
  }
}

// ---- crypto (must match src/core/crypto.js byte for byte) ----
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function verifyString(str: string, sigB64: string, keyB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", b64(keyB64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, b64(sigB64), new TextEncoder().encode(str));
  } catch {
    return false;
  }
}
async function verifyObject(obj: any, keyB64: string): Promise<boolean> {
  if (!obj || typeof obj.sig !== "string") return false;
  const { sig, ...body } = obj;
  return verifyString(canonical(body), sig, keyB64);
}

// ---- helpers ----
const norm = (h: unknown) => String(h ?? "").toLowerCase().replace(/[^a-z0-9_.-]/g, "");
const json = (code: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status: code, headers: { "content-type": "application/json" } });

// The function is mounted under /functions/v1/mpr-relay; signatures cover only the protocol path.
function protocolPath(pathname: string): string {
  const m = pathname.match(/\/v1\/(register|inbox|ack|receipts)(\/|$)/);
  return m ? pathname.slice(m.index!) : pathname;
}

async function readBody(req: Request): Promise<string> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX) throw new Error("too large");
  return new TextDecoder().decode(buf);
}

async function authed(req: Request, pathname: string, key: string): Promise<boolean> {
  const tsHeader = req.headers.get("x-mpr-time") ?? "";
  const ts = Number(tsHeader);
  if (!ts || Math.abs(Date.now() - ts) > SKEW_MS) return false;
  const sig = req.headers.get("x-mpr-sig");
  if (!sig) return false;
  const nonce = req.headers.get("x-mpr-nonce");
  const signed = nonce ? `${req.method} ${pathname} ${tsHeader} ${nonce}` : `${req.method} ${pathname} ${tsHeader}`;
  if (!(await verifyString(signed, sig, key))) return false;
  // Replay protection shared across isolates: a sig can be used once.
  const fresh = await db`insert into mpr.nonces (sig) values (${sig}) on conflict do nothing returning sig`;
  if (Math.random() < 0.05) await db`delete from mpr.nonces where ts < now() - interval '10 minutes'`;
  return fresh.length === 1;
}

async function keyFor(handle: string): Promise<string | undefined> {
  const rows = await db`select key from mpr.registry where handle = ${handle}`;
  return rows[0]?.key;
}

function newId(): string {
  const r = crypto.getRandomValues(new Uint8Array(9));
  return `${Date.now()}_${btoa(String.fromCharCode(...r)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/healthz")) {
      // Touches the database, so health checks also keep the free-tier project from pausing.
      const [{ handles }] = await db`select count(*)::int as handles from mpr.registry`;
      return json(200, { ok: true, version: VERSION, handles, db: dbVia });
    }
    // Housekeeping on a small share of requests: expire undelivered mail.
    if (Math.random() < 0.02) {
      await db`delete from mpr.messages where created < now() - ${RETENTION}::interval`;
      await db`delete from mpr.receipts where read_at < now() - ${RETENTION}::interval`;
    }
    const pathname = protocolPath(url.pathname);
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);

    // Read receipts (deposit ids are random, so only the sender knows them) and a mailbox's last check-in time.
    if (req.method === "GET" && pathname === "/v1/receipts") {
      const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200);
      const h = norm(url.searchParams.get("handle"));
      const rows = ids.length ? await db`select id, read_at from mpr.receipts where id = any(${ids}::text[])` : [];
      const [p] = h ? await db`select last_poll from mpr.registry where handle = ${h}` : [];
      return json(200, { read: Object.fromEntries(rows.map((r: any) => [r.id, new Date(r.read_at).toISOString()])), last_check: p?.last_poll ? new Date(p.last_poll).toISOString() : null });
    }

    if (req.method === "POST" && pathname === "/v1/register") {
      const body = JSON.parse(await readBody(req));
      const handle = norm(body.handle);
      if (!handle || !body.key) return json(400, { error: "handle and key required" });
      if (await overLimit("register", clientIp(req))) return json(429, { error: "too many registrations from this address; try again in a minute" });
      if (!(await authed(req, pathname, body.key))) return json(401, { error: "bad signature" });
      const existing = await keyFor(handle);
      if (!existing) {
        await db`delete from mpr.registry where (handle like 'inv-%' and created < now() - ${INV_TTL}::interval)
                                             or (handle like 'mprtest-%' and created < now() - ${TEST_TTL}::interval)`;
        const eph = EPHEMERAL.test(handle);
        const [{ n }] = eph
          ? await db`select count(*)::int as n from mpr.registry where handle like 'inv-%' or handle like 'mprtest-%'`
          : await db`select count(*)::int as n from mpr.registry where handle not like 'inv-%' and handle not like 'mprtest-%'`;
        if (!eph && n >= MAX_HANDLES) {
          // Reclaim handles whose owners haven't checked their mail in months (and their undelivered mail).
          await db`delete from mpr.registry where handle not like 'inv-%' and handle not like 'mprtest-%' and coalesce(last_seen, created) < now() - ${IDLE_EXPIRY}::interval`;
        }
        const [{ n: n2 }] = eph ? [{ n }] : await db`select count(*)::int as n from mpr.registry where handle not like 'inv-%' and handle not like 'mprtest-%'`;
        if (n2 >= (eph ? MAX_EPHEMERAL : MAX_HANDLES)) return json(507, { error: "relay full" });
        await db`insert into mpr.registry (handle, key) values (${handle}, ${body.key}) on conflict do nothing`;
      }
      // Atomic pin: whoever's insert won owns the handle.
      if ((await keyFor(handle)) !== body.key) return json(409, { error: "handle already registered to another key" });
      return json(200, { ok: true, handle });
    }

    if (parts[0] === "v1" && parts[1] === "inbox" && parts[2]) {
      const handle = norm(parts[2]);
      const key = await keyFor(handle);
      if (!key) return json(404, { error: "unknown handle" });

      if (req.method === "POST") {
        const raw = await readBody(req);
        const env = JSON.parse(raw);
        if (!env?.from?.key || !(await verifyObject(env, env.from.key))) return json(400, { error: "envelope signature invalid" });
        if (norm(env?.to?.handle) !== handle) return json(400, { error: "envelope not addressed to this mailbox" });
        // Per sender key, per recipient mailbox and per network address: fresh keys can't flood one person.
        if (await overLimit("send", env.from.key) || await overLimit("inbox", handle) || await overLimit("ip", clientIp(req))) return json(429, { error: "sending too fast; slow down" });
        const stored = JSON.stringify(env);
        const bytes = new TextEncoder().encode(stored).length;
        const id = newId();
        const ins = await db`
          insert into mpr.messages (id, handle, envelope, bytes)
          select ${id}, ${handle}, ${stored}, ${bytes}
          where (select count(*) from mpr.messages where handle = ${handle}) < ${MAX_MSGS}
            and (select coalesce(sum(bytes), 0) from mpr.messages where handle = ${handle}) + ${bytes} <= ${MAX_BOX_BYTES}
            and (select coalesce(sum(bytes), 0) from mpr.messages) + ${bytes} <= ${MAX_TOTAL_BYTES}
          returning id`;
        if (!ins.length) return json(429, { error: "mailbox full (or relay storage full)" });
        return json(202, { ok: true, id });
      }

      if (req.method === "GET") {
        if (!(await authed(req, pathname, key))) return json(401, { error: "bad signature" });
        if (await overLimit("read", handle)) return json(429, { error: "polling too fast; slow down" });
        await db`update mpr.registry set last_seen = now() where handle = ${handle} and (last_seen is null or last_seen < now() - interval '1 day')`;
        await db`update mpr.registry set last_poll = now() where handle = ${handle} and (last_poll is null or last_poll < now() - interval '30 seconds')`;
        // Long-poll: ?wait=N (≤25 s) holds the request until mail arrives, so AIs hear each other within ~1 s.
        const waitMs = Math.min(Math.max(Number(new URL(req.url).searchParams.get("wait")) || 0, 0), 25) * 1000;
        const until = Date.now() + waitMs;
        let rows = await db`select id, envelope from mpr.messages where handle = ${handle} order by id limit ${FETCH_LIMIT}`;
        while (!rows.length && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 1000));
          rows = await db`select id, envelope from mpr.messages where handle = ${handle} order by id limit ${FETCH_LIMIT}`;
        }
        return json(200, { messages: rows.map((r: any) => ({ id: r.id, envelope: JSON.parse(r.envelope) })) });
      }
    }

    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "ack" && parts[2] && parts[3]) {
      const handle = norm(parts[2]);
      const key = await keyFor(handle);
      if (!key || !(await authed(req, pathname, key))) return json(401, { error: "bad signature" });
      const gone = await db`delete from mpr.messages where handle = ${handle} and id = ${parts[3]} returning id`;
      if (gone.length) await db`insert into mpr.receipts (id) values (${parts[3]}) on conflict do nothing`;
      return json(200, { ok: true });
    }

    return json(404, { error: "not found" });
  } catch (e) {
    // Bad input is the caller's problem (400); anything else is ours and worth retrying (503).
    const msg = (e as Error).message || "error";
    const client = e instanceof SyntaxError || /too large|JSON|URI/i.test(msg);
    if (!client) console.error("relay error", (e as any)?.code, msg);
    return json(client ? 400 : 503, { error: client ? msg : "relay temporarily unavailable; retry shortly" });
  }
});
