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
// A stand-in for the claude command (a .cmd on Windows, a shell script elsewhere).
const fake = (code, text) => process.platform === "win32"
  ? fs.writeFileSync(path.join(tmp, "bin", "claude.cmd"), `@echo off\r\nmore >nul\r\necho ${text}\r\nexit /b ${code}\r\n`)
  : fs.writeFileSync(path.join(tmp, "bin", "claude"), `#!/bin/sh\ncat >/dev/null\necho "${text}"\nexit ${code}\n`, { mode: 0o755 });
process.env.PATH = path.join(tmp, "bin") + path.delimiter + process.env.PATH;
const { MPR } = await import("../src/core/service.js");
const { autopilot, parseRun } = await import("../src/autopilot.js");

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

  await t("claude's JSON answer gives the text, its exit status and the session id; plain text still works", async () => {
    const j = parseRun(0, JSON.stringify({ result: "hi", session_id: "s", is_error: false }), "");
    assert.deepEqual([j.code, j.stdout, j.session_id], [0, "hi", "s"]);
    assert.equal(parseRun(0, JSON.stringify({ result: "x", is_error: true }), "").code, 1);
    assert.equal(parseRun(0, "plain", "").session_id, null);
  });

  await t("the helper resumes one Claude session per conversation, from the session id Claude returned", async () => {
    if (process.platform === "win32") return; // the stand-in is a shell script
    const argsLog = path.join(tmp, "claude-args.log");
    fs.writeFileSync(path.join(tmp, "bin", "claude"), `#!/bin/sh\ncat >/dev/null\necho "$@" >> "${argsLog}"\necho '{"type":"result","is_error":false,"result":"answered","session_id":"sess-1"}'\n`, { mode: 0o755 });
    const first = await a.send({ to: "bb", text: "Second question: lunch?" });
    await autopilot({ home: path.join(tmp, "b"), once: true, log: quiet });
    assert.equal(b.store.getState().autopilot_sessions[first.thread].session_id, "sess-1");
    await a.send({ to: "bb", thread: first.thread, text: "And dinner?" });
    await autopilot({ home: path.join(tmp, "b"), once: true, log: quiet });
    const calls = fs.readFileSync(argsLog, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    assert.ok(!calls[0].includes("--resume"), "the first wake-up starts a session");
    assert.ok(calls[1].includes("--resume sess-1"), "the second wake-up resumes it");
  });

  await t("a note the helper collected still shows up in the person's next session, exactly once", async () => {
    await a.send({ to: "bb", text: "FYI: the report is in the shared folder.", done: true });
    const helper = await b.checkInbox({ helper: true });
    assert.ok(helper.new_notes.some((n) => /shared folder/.test(n.text)), "the helper fetches it");
    const session = await b.checkInbox();
    assert.ok(session.new_notes.some((n) => /shared folder/.test(n.text)), "the person's next session still gets it");
    const again = await b.checkInbox();
    assert.ok(!again.new_notes.some((n) => /shared folder/.test(n.text)), "and it isn't shown a second time");
  });
} finally {
  relay.kill();
  console.log(`${passed} passed`);
}
