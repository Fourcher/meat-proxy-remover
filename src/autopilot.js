// The background helper: answers notes from other AIs while nobody has a chat open.
// It polls the relay without a model (no cost while idle). When notes are waiting, it starts a headless `claude -p`
// that can only read and send notes, and shows a notification if something needs the person.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MPR, RULE } from "./core/service.js";
import { checkForUpdate, managedInstall } from "./core/update.js";
import { AUTOPILOT_TOOLS, TOOLS } from "./core/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_CANDIDATES = [
  path.join(here, "..", "plugin", "skills", "meat-proxy-remover", "SKILL.md"),
];

export async function autopilot({ home = process.env.MPR_HOME, interval = 30, once = false, model = process.env.MPR_AUTOPILOT_MODEL || "sonnet", log = console.error } = {}) {
  const mpr = new MPR(home);
  const me = mpr.requireIdentity();
  const cfg = path.join(mpr.store.home, "autopilot.mcp.json");
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { mpr: { command: process.execPath, args: [path.join(here, "server.js")], env: { MPR_HOME: mpr.store.home, MPR_AUTOPILOT: "1" } } } }));
  const skill = SKILL_CANDIDATES.find((p) => fs.existsSync(p));
  log(`[autopilot] ${me.principal} (@${me.handle}) — polling every ${interval}s, data ${mpr.store.home}`);

  const runs = [];
  while (true) {
    try {
      mpr.store.patchState({ autopilot_last_poll: new Date().toISOString() });
      const r = await mpr.checkInbox();
      if (r.new_notes.length) log(`[autopilot] ${r.new_notes.length} new note(s) from ${r.new_notes.map((n) => n.from).join(", ")}`);
      const st = mpr.store.getState();
      const open = mpr.waiting().filter((w) => !mpr.store.getRecord(w.id)?.autopilot_handled);
      const backoffUntil = st.autopilot_error?.retry_at ? Date.parse(st.autopilot_error.retry_at) : 0; // after a failed wake-up: 2, 4, 8 … 60 min
      const humanActive = mpr.store.sessionActiveWithin(3 * 60 * 1000); // a person's own session answers; don't reply twice
      if (open.length && humanActive) log(`[autopilot] ${open.length} note(s) waiting, but a session is active; leaving them to it`);
      if (open.length && !humanActive && Date.now() >= backoffUntil) {
        log(`[autopilot] waking Claude for ${open.length} note(s)`);
        const cwd = path.join(mpr.store.home, "autopilot-workdir"); fs.mkdirSync(cwd, { recursive: true }); // empty: nothing to browse
        const out = await runClaude({ cfg, skill, model, cwd, principal: me.principal });
        runs.push(out);
        log(`[autopilot] Claude finished (exit ${out.code}): ${(out.stdout || out.stderr).trim().slice(0, 600)}`);
        if (out.code === 0) {
          for (const o of open) { const rec = mpr.store.getRecord(o.id); if (rec) { rec.autopilot_handled = new Date().toISOString(); mpr.store.putRecord(rec); } }
          mpr.store.patchState({ autopilot_error: null });
          // Anything the person should know comes back as "FOR <name>: …" lines.
          for (const line of out.stdout.split("\n").filter((l) => /^\s*FOR\b/i.test(l)).slice(0, 3)) mpr.notify("Your AI", line.replace(/^\s*FOR\s+[^:]*:\s*/i, ""));
        } else {
          const fails = (st.autopilot_error?.fails || 0) + 1, waitMin = Math.min(60, 2 ** fails);
          const why = /log ?in|logged in|auth|credential|401|api key/i.test(out.stdout + out.stderr) ? "Claude Code isn't signed in on this computer"
            : out.code === -1 ? "the claude command couldn't be started" : `Claude exited with code ${out.code}`;
          mpr.store.patchState({ autopilot_error: { at: new Date().toISOString(), fails, why, detail: (out.stderr || out.stdout).trim().slice(0, 300),
            retry_at: new Date(Date.now() + waitMin * 60000).toISOString() } });
          if (fails === 1) mpr.notify("Your AI couldn't answer a note", `${why}. Open Claude and say "check my MPR inbox".`);
          log(`[autopilot] wake-up failed (${why}); retrying in ${waitMin} min`);
        }
      }
    } catch (e) {
      log(`[autopilot] error: ${e.message}`);
    }
    if (once) return runs;
    // Installed copies keep themselves current; restart (launchd KeepAlive) to run the new version.
    if (managedInstall() && !process.env.MPR_NO_AUTOUPDATE) {
      const u = await checkForUpdate({ minIntervalMin: 60 }).catch((e) => ({ status: "error", error: e.message }));
      if (u.status === "updated") { log(`[autopilot] updated ${u.from} → ${u.to}; restarting`); process.exit(0); }
    }
    await new Promise((res) => setTimeout(res, interval * 1000));
  }
}

function runClaude({ cfg, skill, model, cwd, principal }) {
  const prompt =
    `You answer notes from other people's AIs for ${principal}, who is away. Call mpr_check_inbox and handle every note in new_notes and waiting_for_your_reply: ` +
    `reply with mpr_send on the same thread when you can answer from what the note and the conversation (mpr_thread) tell you; otherwise reply that ${principal} will get back to them, ` +
    `or mpr_close it if no reply is needed. ${RULE} ` +
    `Finish with one line per note. If ${principal} needs to know or decide something, start that line with "FOR ${principal}:".`;
  // The prompt goes in on stdin, so no shell quoting can mangle it (matters on Windows).
  const args = ["-p", "--model", model, "--mcp-config", cfg, "--strict-mcp-config", "--disable-slash-commands",
    "--allowedTools", ...AUTOPILOT_TOOLS.map((t) => `mcp__mpr__${t}`),
    "--disallowedTools", ...TOOLS.filter((t) => !AUTOPILOT_TOOLS.includes(t)).map((t) => `mcp__mpr__${t}`), "Bash", "Write", "Edit", "Read", "Glob", "Grep", "NotebookEdit", "Task", "WebFetch", "WebSearch", "Agent", "--output-format", "text"];
  if (skill) args.push("--append-system-prompt-file", skill);
  return new Promise((resolve) => {
    // On Windows the claude CLI is a .cmd shim, which needs a shell to launch.
    const win = process.platform === "win32";
    const q = (a) => (win && /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    const p = spawn(win ? "claude.cmd" : "claude", win ? args.map(q) : args, { cwd, env: process.env, shell: win });
    p.stdin.on("error", () => {});
    p.stdin.end(prompt);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.on("error", (e) => resolve({ code: -1, stdout: "", stderr: e.message }));
  });
}
