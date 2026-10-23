// Drives real MCP server processes over stdio JSON-RPC, exactly as Claude would.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "test", ".tmp-mcp");
fs.rmSync(tmp, { recursive: true, force: true });
const { spawn } = await import("node:child_process");
const port = 27787 + Math.floor(Math.random() * 1000);
const relayProc = spawn(process.execPath, [path.join(root, "relay", "relay.js")], { env: { ...process.env, PORT: String(port), MPR_RELAY_DATA: path.join(tmp, "relay") }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise((res) => relayProc.stderr.once("data", res));
const relayUrl = `http://127.0.0.1:${port}`;

// Claude's settings from an older install: a renamed tool, a removed tool, and an unrelated rule that must survive.
const claudeDir = path.join(tmp, "claude");
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status)", "mcp__mpr__mpr_wait", "mcp__mpr__mpr_setup", "mcp__mpr__mpr_send"] } }, null, 2));

async function connect(name, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "server.js")],
    env: { ...process.env, MPR_HOME: path.join(tmp, name), MPR_ROOT: path.join(tmp, "root"), MPR_NO_NOTIFY: "1", MPR_NO_AUTOUPDATE: "1",
      MPR_RELAY: relayUrl, CLAUDE_CONFIG_DIR: claudeDir, ...extraEnv },
  });
  const client = new Client({ name: `test-${name}`, version: "1.0.0" });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  };
  return { client, call };
}

console.log("MCP stdio tests");
const J = await connect("jordan");
const A = await connect("alice");
try {
  const tools = (await J.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["mpr_accept_invite", "mpr_doctor", "mpr_inbox", "mpr_invite", "mpr_send", "mpr_thread"]);
  const ann = Object.fromEntries((await J.client.listTools()).tools.map((t) => [t.name, t.annotations || {}]));
  assert.ok(ann.mpr_inbox.readOnlyHint && ann.mpr_thread.readOnlyHint, "inbox and thread are read-only, so hosts run them unprompted");
  assert.ok(!ann.mpr_send.readOnlyHint && !ann.mpr_doctor.readOnlyHint, "send and doctor are not");
  console.log(`  ✓ ${tools.length} tools listed`);

  const allow = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")).permissions.allow;
  assert.ok(allow.includes("Bash(git status)"), "unrelated rules are kept");
  assert.ok(!allow.includes("mcp__mpr__mpr_wait") && !allow.includes("mcp__mpr__mpr_setup"), "renamed and removed tools are dropped");
  for (const t of tools) assert.ok(allow.includes(`mcp__mpr__${t}`), `${t} is pre-approved`);
  console.log("  ✓ after an update, approvals name the current tools and drop the old ones");

  // The first invite creates the identity from the principal's name.
  const inv = await J.call("mpr_invite", { to_principal: "Alice Chen", text: "Can you do a call Thursday at 3pm CT?", principal: "Jordan Fourcher", handle: "jordan" });
  const acc = await A.call("mpr_accept_invite", { code: inv.message_text.match(/mpr1:[A-Za-z0-9_-]+/)[0], principal: "Alice Chen", handle: "alice" });
  assert.match(acc.their_note.text, /Thursday at 3pm/);
  console.log("  ✓ invite (creates identity on first use) + accept over MCP");

  const sent = await A.call("mpr_send", { to: "jordan", thread: acc.their_note.thread, text: "Thursday 3pm CT works." });
  assert.equal(sent.sent, true);
  const got = await J.call("mpr_inbox", { thread: acc.their_note.thread, wait_sec: 10 });
  assert.ok(got.new_notes.some((n) => n.text === "Thursday 3pm CT works."), JSON.stringify(got));
  console.log("  ✓ note → reply over MCP, and mpr_inbox with wait_sec returns the note");

  const history = await J.call("mpr_thread", { thread: acc.their_note.thread });
  assert.ok(history.events.length >= 2, "thread shows both sides");
  const everything = await J.call("mpr_thread", {});
  assert.ok(Array.isArray(everything.threads) && Array.isArray(everything.files), "no thread lists threads and files");
  const doc = await J.call("mpr_doctor", {});
  assert.ok(doc.contacts.some((c) => c.handle === "alice"), "doctor lists contacts");
  assert.match(doc.remove_contact, /disconnects one contact/, "doctor says what remove_contact does");
  console.log("  ✓ thread history, file list and contacts");

  await assert.rejects(() => J.call("mpr_send", { to: "nobody", text: "hi" }), /isn't a contact/);
  console.log("  ✓ errors surface as isError");

  // The background helper's server only offers messaging.
  const H = await connect("jordan", { MPR_AUTOPILOT: "1" });
  try {
    await assert.rejects(() => H.call("mpr_invite", { to_principal: "X", text: "hi" }), /background helper/);
    await assert.rejects(() => H.call("mpr_doctor", { remove_contact: "alice" }), /background helper/);
    assert.ok(Array.isArray((await H.call("mpr_inbox", {})).new_notes));
  } finally { await H.client.close(); }
  console.log("  ✓ the background helper can only read and send notes");
} finally {
  relayProc.kill();
  await J.client.close();
  await A.client.close();
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("all MCP tests passed");
