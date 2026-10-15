// Autopilot: a failed Claude wake-up (e.g. not signed in) must not swallow messages; it backs off, tells the human
// once, shows up in doctor, and succeeds on a later attempt.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "test", ".tmp-autopilot");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
process.env.MPR_NO_NOTIFY = "1"; process.env.MPR_NO_AUTOUPDATE = "1";
process.env.MPR_ROOT = path.join(tmp, "root");
const fake = (code, text) => fs.writeFileSync(path.join(tmp, "bin", "claude"), `#!/bin/sh\ncat >/dev/null\necho "${text}"\nexit ${code}\n`, { mode: 0o755 });
process.env.PATH = path.join(tmp, "bin") + ":" + process.env.PATH;
const { MPR } = await import("../src/core/service.js");
const { autopilot } = await import("../src/autopilot.js");

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e)); process.exitCode = 1; }
}
const port = 24787 + Math.floor(Math.random() * 1000);
const relay = spawn(process.execPath, [path.join(root, "relay", "relay.js")], { env: { ...process.env, PORT: String(port), MPR_RELAY_DATA: path.join(tmp, "relay") }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise((res) => relay.stderr.once("data", res));
const url = `http://127.0.0.1:${port}`;
console.log("Autopilot tests");
try {
  const a = new MPR(path.join(tmp, "a")), b = new MPR(path.join(tmp, "b"));
  await a.setup({ principal: "A", handle: "aa", relay: url });
  await b.setup({ principal: "B", handle: "bb", relay: url });
  const inv = await a.invite({ to_principal: "B", text: "connect" });
  await b.acceptInvite({ code: inv.message_text.match(/mpr1:[A-Za-z0-9_-]+/)[0], principal: "B" });
  await b.close({ id: b.store.listRecords().find((r) => r.kind === "inbound").id }); // the invite note itself
  await a.checkInbox();
  await a.send({ to: "bb", text: "What time works Thursday?" });
  const quiet = () => {};

  await t("Claude not signed in: item stays open, error recorded with backoff, doctor shows it", async () => {
    fake(1, "Invalid API key · Please run /login");
    await autopilot({ home: path.join(tmp, "b"), once: true, log: quiet });
    const st = b.store.getState();
    assert.match(st.autopilot_error.why, /signed in/);
    assert.ok(new Date(st.autopilot_error.retry_at) > new Date());
    assert.equal(b.store.listRecords().filter((r) => r.autopilot_handled).length, 0, "nothing marked handled");
    const d = b.doctor ? await b.doctor() : null;
    if (d) assert.ok(d.checks.some((c) => c.name === "helper wake-ups" && !c.ok));
  });

  await t("during backoff it doesn't retry; after backoff a working Claude handles it and clears the error", async () => {
    fake(0, "answered");
    await autopilot({ home: path.join(tmp, "b"), once: true, log: quiet });
    const handled = () => b.store.listRecords().filter((r) => r.autopilot_handled).length;
    assert.equal(handled(), 0, "still backing off");
    const st = b.store.getState(); st.autopilot_error.retry_at = new Date(Date.now() - 1000).toISOString(); b.store.setState(st);
    await autopilot({ home: path.join(tmp, "b"), once: true, log: quiet });
    const after = b.store.getState();
    assert.equal(after.autopilot_error, null);
    assert.equal(handled(), 1);
  });
} finally {
  relay.kill();
  console.log(`${passed} passed`);
}
