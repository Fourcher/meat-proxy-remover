// End-to-end encryption: the relay only ever stores sealed envelopes; old contacts upgrade automatically.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "test", ".tmp-crypto");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.MPR_NO_NOTIFY = "1";
process.env.MPR_ROOT = path.join(tmp, "root");
const { MPR } = await import("../src/core/service.js");
const { seal } = await import("../src/core/crypto.js");

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e)); process.exitCode = 1; }
}
const port = 22787 + Math.floor(Math.random() * 1000);
const relayData = path.join(tmp, "relay");
const relay = spawn(process.execPath, [path.join(root, "relay", "relay.js")], {
  env: { ...process.env, PORT: String(port), MPR_RELAY_DATA: relayData }, stdio: ["ignore", "ignore", "pipe"],
});
await new Promise((res) => relay.stderr.once("data", res));
const url = `http://127.0.0.1:${port}`;
const stored = () => {
  const out = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith(".json") && !f.name.startsWith("registry") && out.push(fs.readFileSync(path.join(d, f.name), "utf8")); };
  walk(relayData); return out.join("\n");
};

console.log("Encryption tests");
const a = new MPR(path.join(tmp, "a")), b = new MPR(path.join(tmp, "b"));
try {
  await t("new identities and cards carry an X25519 key", async () => {
    await a.setup({ principal: "Alice", handle: "alice", relay: url });
    await b.setup({ principal: "Bob", handle: "bob", relay: url });
    assert.ok(a.card().enc && b.card().enc);
  });

  await t("messages are sealed on the relay; recipient decrypts and verifies", async () => {
    const inv = await a.invite({ to_principal: "Bob", text: "connect" });
    await b.acceptInvite({ code: inv.message_text.match(/mpr1:[A-Za-z0-9_-]+/)[0], principal: "Bob" });
    await a.checkInbox();
    assert.ok(a.store.getContact("bob").enc, "inviter learned bob's encryption key");
    const SECRET = "Q3 revenue was 264,000 SECRETWORD";
    const r = await a.send({ to: "bob", text: SECRET + "\nrunway 19 months" });
    assert.equal(r.encrypted, true);
    assert.doesNotMatch(stored(), /SECRETWORD|runway 19/, "relay must never hold plaintext");
    assert.match(stored(), /sealed\/1/);
    const w = await b.wait({ thread: r.thread, timeout_sec: 5 });
    assert.equal(w.new_notes[0].text, SECRET + "\nrunway 19 months");
  });

  await t("replies are encrypted too (both directions)", async () => {
    const r = await b.send({ to: "alice", text: "OTHERSECRET?" });
    assert.equal(r.encrypted, true);
    assert.doesNotMatch(stored(), /OTHERSECRET/);
    await a.wait({ thread: r.thread, timeout_sec: 5 });
  });

  await t("a sealed message for someone else, or tampered in transit, is rejected", async () => {
    const c = new MPR(path.join(tmp, "c"));
    await c.setup({ principal: "Carol", handle: "carol", relay: url });
    const env = a.store.listRecords().find((x) => x.kind === "outbound").envelope;
    const forCarol = seal(env, c.requireIdentity().encPublicKey, a.requireIdentity().privateKey);
    const r1 = b.processInbound(forCarol, "test");
    assert.equal(r1.ignored, true); assert.match(r1.why, /decrypt/);
    const good = seal({ ...env, id: "env_tamper" }, b.requireIdentity().encPublicKey, a.requireIdentity().privateKey);
    const r2 = b.processInbound({ ...good, ct: good.ct.replace(/^.{8}/, "AAAAAAAA") }, "test");
    assert.equal(r2.ignored, true);
  });

  await t("a pre-encryption contact (no enc on file) is upgraded by its first signed message", async () => {
    const bob = a.store.getContact("bob"); delete bob.enc; a.store.putContact(bob);
    const r = await a.send({ to: "bob", text: "plain because key unknown" });
    assert.equal(r.encrypted, false);
    await b.wait({ thread: r.thread, timeout_sec: 5 });
    const back = await b.send({ to: "alice", text: "hi again" });
    await a.wait({ thread: back.thread, timeout_sec: 5 });
    assert.ok(a.store.getContact("bob").enc, "learned from bob's signed message");
    assert.equal((await a.send({ to: "bob", text: "now sealed" })).encrypted, true);
  });

  await t("an old identity without an encryption key gets one on first use", async () => {
    const id = a.store.getIdentity(); delete id.encPublicKey; delete id.encPrivateKey; a.store.setIdentity(id);
    assert.ok(a.requireIdentity().encPublicKey);
  });
} finally {
  relay.kill();
  console.log(`${passed} passed`);
}
