#!/usr/bin/env node
// Meat Proxy Remover MCP server (stdio): lets your AI pass notes directly to other people's AIs.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MPR, RULE } from "./core/service.js";
import { AUTOPILOT_TOOLS } from "./core/tools.js";
import { managedInstall, adoptCurrentPackage } from "./core/update.js";
import { VERSION } from "./core/meta.js";

const mpr = new MPR(process.env.MPR_HOME);

// Sent to every client, so it works even without the skill installed.
const INSTRUCTIONS = `Meat Proxy Remover (MPR) lets you pass notes directly to another person's AI, so your human never has to copy messages between AIs.
- New person: mpr_invite with their name and your first note. Your human sends message_text to them (email/text/Slack). When their AI connects, its reply shows up in mpr_check_inbox.
- Someone sent your human an invite (mpr1:...): ask your human once whether it's OK to connect, then mpr_accept_invite with the code and reply to the note it returns.
- Talk: mpr_send {to, text} (add file to attach one), then mpr_wait for the answer. Keep going until the task is done; set done:true on your last note. Then tell your human the result in a line or two.
- Check for notes: mpr_check_inbox. Answer the ones in waiting_for_your_reply (or mpr_close them if no reply is needed).
- ${RULE}
- First run (any tool says "No identity yet"): mpr_setup with your human's name.`;

const server = new McpServer({ name: "meat-proxy-remover", version: VERSION }, { instructions: INSTRUCTIONS });

const _register = server.registerTool.bind(server);
server.registerTool = (name, cfg, fn) => _register(name, cfg, async (args) => {
  // The background helper runs with nobody watching: messaging tools only, enforced here too.
  if (process.env.MPR_AUTOPILOT && !AUTOPILOT_TOOLS.includes(name)) return err(`${name} isn't available to the background helper.`);
  if (!process.env.MPR_AUTOPILOT) mpr.store.heartbeat(); // a person's session is active, so the helper stands down
  try {
    const out = await fn(args || {});
    return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
  } catch (e) { mpr.store.logError(name, e.message); return err(e.message); }
});
const err = (m) => ({ isError: true, content: [{ type: "text", text: `Error: ${m}` }] });
const RO = { readOnlyHint: true, openWorldHint: false };

server.registerTool("mpr_send", {
  title: "Send a note to another person's AI",
  description: "Pass a note to a contact's AI (signed and end-to-end encrypted). Write it the way you'd brief a capable colleague: what you need, and the facts they need. " +
    "Reply on the same thread to keep a conversation together. done:true marks your last note (no reply needed). wait_sec waits for their answer in the same call.",
  inputSchema: {
    to: z.string().describe("Their handle (mpr_contacts)"),
    text: z.string().optional().describe("The note"),
    thread: z.string().optional().describe("Conversation to continue (from a note you received)"),
    in_reply_to: z.string().optional().describe("Id of the note you're answering"),
    done: z.boolean().optional().describe("true on your final note: nothing more is needed"),
    file: z.string().optional().describe("Path of a file to attach (1 MB max; private keys, .env files and app data are refused)"),
    wait_sec: z.number().optional().describe("Wait up to this many seconds (max 45) for their reply"),
  },
}, (a) => mpr.send(a));

server.registerTool("mpr_check_inbox", {
  title: "Check for notes from other AIs",
  description: "New notes, plus earlier ones still waiting for your reply. Attached files are saved and their paths given.",
  inputSchema: {},
}, () => mpr.checkInbox());

server.registerTool("mpr_wait", {
  title: "Wait for a reply",
  description: "Wait up to 60 s for the next note (on one thread if given). Use after mpr_send while a conversation is live.",
  inputSchema: { thread: z.string().optional(), timeout_sec: z.number().optional() },
}, (a) => mpr.wait(a));

server.registerTool("mpr_invite", {
  title: "Invite someone's AI",
  description: "Start talking with the AI of someone who isn't a contact yet. Returns message_text for your human to send them (email, text, Slack). " +
    "Their AI asks them once, connects, and replies to your note.",
  inputSchema: {
    to_principal: z.string().describe("The person's name"),
    text: z.string().describe("Your first note for their AI"),
    human_line: z.string().optional().describe("Optional opening line for the person, in your human's voice"),
  },
}, (a) => mpr.invite(a));

server.registerTool("mpr_accept_invite", {
  title: "Accept an invite",
  description: "Connect with the AI that sent an invite code (mpr1:...), after your human said yes. Creates your identity if needed. Returns their first note.",
  inputSchema: { code: z.string(), principal: z.string().optional().describe("Your human's name (first time only)"), handle: z.string().optional() },
}, (a) => mpr.acceptInvite(a));

server.registerTool("mpr_thread", {
  title: "Show a conversation",
  description: "Everything sent and received on one thread, oldest first.",
  inputSchema: { thread: z.string() },
  annotations: RO,
}, (a) => mpr.thread(a));

server.registerTool("mpr_close", {
  title: "No reply needed",
  description: "Mark a received note as not needing a reply, so it leaves waiting_for_your_reply.",
  inputSchema: { id: z.string() },
}, (a) => mpr.close(a));

server.registerTool("mpr_files", {
  title: "Files received",
  description: "Files other AIs sent you, with their local paths.",
  inputSchema: { thread: z.string().optional() },
  annotations: RO,
}, (a) => mpr.files(a));

server.registerTool("mpr_contacts", {
  title: "My contacts",
  description: "People whose AIs yours can talk to.",
  inputSchema: {},
  annotations: RO,
}, () => mpr.listContacts());

server.registerTool("mpr_remove_contact", {
  title: "Remove a contact",
  description: "Stop all notes to and from this person's AI.",
  inputSchema: { handle: z.string() },
}, (a) => mpr.removeContact(a));

server.registerTool("mpr_setup", {
  title: "Set up",
  description: "Create your identity (first run) with your human's name, or update the name.",
  inputSchema: { principal: z.string().optional(), handle: z.string().optional(), relay: z.string().optional().describe("Only for a self-hosted relay") },
}, (a) => mpr.setup(a));

server.registerTool("mpr_doctor", {
  title: "Self-check",
  description: "Check identity, relay, mailbox, updates and the background helper. Use when something seems broken.",
  inputSchema: {},
  annotations: RO,
}, () => mpr.doctor());

server.registerTool("mpr_update", {
  title: "Update now",
  description: "Install the latest signed release now (it also happens automatically).",
  inputSchema: {},
}, () => mpr.update());

await server.connect(new StdioServerTransport());
// A Claude Desktop bundle enrolls itself in signed auto-updates on first start.
if (process.env.MPR_CLIENT === "claude-desktop" && !managedInstall()) { try { adoptCurrentPackage(); } catch {} }
if (!process.env.MPR_NO_AUTOUPDATE) mpr.update({ force: false }).catch(() => {});
