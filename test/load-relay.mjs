// Load test against the live relay: P pairs of AIs exchange notes at once (bursts + long-poll waits).
// Usage: node test/load-relay.mjs [pairs=4] [notesEach=25]
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BURST = process.argv[4] !== "serial"; const PAIRS = Number(process.argv[2] || 4), N = Number(process.argv[3] || 25);
const tmp = path.join(ROOT, "test", ".tmp-load"); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
process.env.MPR_NO_NOTIFY = "1"; process.env.MPR_NO_AUTOUPDATE = "1"; process.env.MPR_ROOT = path.join(tmp, "root");
const { MPR } = await import(path.join(ROOT, "src/core/service.js"));
const tag = Date.now().toString(36);
const pairs = [];
for (let i = 0; i < PAIRS; i++) {
  const a = new MPR(path.join(tmp, `a${i}`)), b = new MPR(path.join(tmp, `b${i}`));
  await a.setup({ principal: `Load A${i}`, handle: `mprload-a${i}-${tag}` });
  await b.setup({ principal: `Load B${i}`, handle: `mprload-b${i}-${tag}` });
  const inv = await a.invite({ to_principal: `Load B${i}`, text: "load test" });
  await b.acceptInvite({ code: inv.message_text.match(/mpr1:[A-Za-z0-9_-]+/)[0] });
  await a.checkInbox();
  pairs.push({ a, b, bh: b.requireIdentity().handle, ah: a.requireIdentity().handle });
}
console.log(`${PAIRS} pairs connected through the live relay`);
const t0 = Date.now(), lat = [];
let sent = 0, queued = 0, failed = 0; const codes = {};
// Every A bursts N notes at its B while every B is long-polling; then B answers each.
await Promise.all(pairs.map(async ({ a, b, bh, ah }) => {
  const recv = (async () => { let got = 0; const until = Date.now() + 240000; while (got < N && Date.now() < until) { const w = await b.wait({ timeout_sec: 30 }); got += w.new_notes.length; } return got; })();
  await Promise.all(Array.from({ length: N }, async (_, k) => {
    const s0 = Date.now(); const r = await a.send({ to: bh, text: `note ${k} ${"x".repeat(400)}` }); lat.push(Date.now() - s0);
    if (r.queued) queued++; else if (r.sent) sent++; else failed++;
    const rec = a.store.getRecord(r.id); for (const d of rec?.delivery || []) codes[d.status || d.error] = (codes[d.status || d.error] || 0) + 1;
  }));
  if (queued) for (let i = 0; i < 6; i++) { await a.checkInbox(); if (!a.store.readJson("outbox.json", []).length) break; await new Promise((r) => setTimeout(r, 10000)); }
  const got = await recv;
  return got;
})).then((gots) => {
  const total = PAIRS * N, received = gots.reduce((x, y) => x + y, 0);
  lat.sort((x, y) => x - y);
  console.log(JSON.stringify({ notes: total, sent_first_try: sent, queued_then_retried: queued, failed, received, all_delivered: received === total, first_attempt_results: codes,
    send_ms: { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], max: lat.at(-1) }, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1));
});
fs.rmSync(tmp, { recursive: true, force: true });
