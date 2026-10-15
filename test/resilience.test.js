// Resilience: relay outages queue and retry, relay moves migrate everyone, lost registrations heal themselves.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "test", ".tmp-resilience");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.MPR_NO_NOTIFY = "1";
process.env.MPR_ROOT = path.join(tmp, "root");
const { MPR } = await import("../src/core/service.js");
const { TRUST } = await import("../src/core/meta.js");

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e)); process.exitCode = 1; }
}
const port = 23787 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}`;
let relay;
const startRelay = async (data = path.join(tmp, "relay")) => {
  relay = spawn(process.execPath, [path.join(root, "relay", "relay.js")], { env: { ...process.env, PORT: String(port), MPR_RELAY_DATA: data }, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise((res) => relay.stderr.once("data", res));
};
const stopRelay = async () => { relay.kill(); await new Promise((r) => relay.once("exit", r)); };

console.log("Resilience tests");
await startRelay();
const a = new MPR(path.join(tmp, "a")), b = new MPR(path.join(tmp, "b"));
try {
  await a.setup({ principal: "A", handle: "aa", relay: url });
  await b.setup({ principal: "B", handle: "bb", relay: url });
  const inv = await a.invite({ to_principal: "B", text: "connect" });
  await b.acceptInvite({ code: inv.message_text.match(/mpr1:[A-Za-z0-9_-]+/)[0], principal: "B" });
  await a.checkInbox();

  await t("relay down: send is queued (not lost, no human prompt) and delivered once it's back", async () => {
    await stopRelay();
    const r = await a.send({ to: "bb", text: "sent while relay was down" });
    assert.equal(r.sent, true); assert.equal(r.queued, true);
    await startRelay();
    await a.checkInbox(); // flushes the outbox
    assert.equal(a.store.readJson("outbox.json", []).length, 0);
    const w = await b.wait({ thread: r.thread, timeout_sec: 5 });
    assert.equal(w.new_notes[0].text, "sent while relay was down");
  });

  await t("relay lost our registration (reset): next inbox check re-registers and mail flows again", async () => {
    await stopRelay();
    await startRelay(path.join(tmp, "relay-fresh"));      // empty relay: nobody registered
    await b.checkInbox();                                   // b heals itself
    const r = await a.send({ to: "bb", text: "after reset" });
    assert.ok(r.sent);
    if (r.queued) await a.checkInbox();                     // a re-registers too and flushes
    const w = await b.wait({ thread: r.thread, timeout_sec: 5 });
    assert.equal(w.new_notes[0].text, "after reset");
  });

  await t("relay move in trust.json migrates identity and contacts on load", async () => {
    const NEW = "http://127.0.0.1:1/new-relay";
    TRUST.relay_moves = { [url]: NEW };
    const a2 = new MPR(path.join(tmp, "a"));
    assert.equal(a2.requireIdentity().transports.relay, NEW);
    assert.equal(a2.store.getContact("bb").transports.relay, NEW);
    delete TRUST.relay_moves;
  });
} finally {
  relay?.kill();
  console.log(`${passed} passed`);
}
