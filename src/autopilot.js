// The background helper: answers notes from other AIs while nobody has a chat open.
// It polls the relay without a model (no cost while idle). When notes are waiting, it resumes one headless `claude -p`
// session per conversation, so the answer keeps the task's context. The session can only read and send notes, and a
// notification shows if something needs the person.
import { claudeBin, resetClaudeBin } from "./claudebin.js";
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
const MAX_SESSIONS = 100; // resumable Claude sessions kept, one per conversation; the least recently used go first

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
      const r = await mpr.checkInbox({ helper: true }); // the helper's fetch must not count as the person having seen the notes
      if (r.new_notes.length) log(`[autopilot] ${r.new_notes.length} new note(s) from ${r.new_notes.map((n) => n.from).join(", ")}`);
      const st = mpr.store.getState();
      const open = mpr.waiting().filter((w) => !mpr.store.getRecord(w.id)?.autopilot_handled);
      const backoffUntil = st.autopilot_error?.retry_at ? Date.parse(st.autopilot_error.retry_at) : 0; // after a failed wake-up: 2, 4, 8 … 60 min
      const humanActive = mpr.store.sessionActiveWithin(3 * 60 * 1000); // a person's own session answers; don't reply twice
      if (open.length && humanActive) log(`[autopilot] ${open.length} note(s) waiting, but a session is active; leaving them to it`);
      if (open.length && !humanActive && Date.now() >= backoffUntil) {
        const cwd = path.join(mpr.store.home, "autopilot-workdir"); fs.mkdirSync(cwd, { recursive: true }); // empty: nothing to browse
        const failed = await answerThreads({ mpr, open, cfg, skill, model, cwd, principal: me.principal, log, runs });
        if (!failed) {
          mpr.store.patchState({ autopilot_error: null });
        } else {
          const fails = (st.autopilot_error?.fails || 0) + 1, waitMin = Math.min(60, 2 ** fails);
          const why = /log ?in|logged in|auth|credential|401|api key/i.test(failed.stdout + failed.stderr) ? "Claude Code isn't signed in on this computer"
            : failed.code === -1 ? "the claude command couldn't be started" : `Claude exited with code ${failed.code}`;
          mpr.store.patchState({ autopilot_error: { at: new Date().toISOString(), fails, why, detail: (failed.stderr || failed.stdout).trim().slice(0, 300),
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

/**
 * One wake-up per conversation, each resuming that conversation's Claude session. Stops at the first failure and
 * returns that run; returns null when every conversation was answered.
 */
async function answerThreads({ mpr, open, cfg, skill, model, cwd, principal, log, runs }) {
  const byThread = new Map();
  for (const o of open) byThread.set(o.thread, [...(byThread.get(o.thread) || []), o]);
  for (const [thread, items] of byThread) {
    const session = mpr.store.getState().autopilot_sessions?.[thread]?.session_id || null;
    log(`[autopilot] waking Claude for ${items.length} note(s) on ${thread}${session ? " (resuming its session)" : ""}`);
    let out = await runClaude({ cfg, skill, model, cwd, principal, thread, session });
    if (out.code !== 0 && session && /no conversation found|session.*not found/i.test(out.stdout + out.stderr)) {
      log(`[autopilot] the session for ${thread} is gone; starting a new one`);
      out = await runClaude({ cfg, skill, model, cwd, principal, thread, session: null });
    }
    runs.push(out);
    log(`[autopilot] Claude finished (exit ${out.code}): ${(out.stdout || out.stderr).trim().slice(0, 600)}`);
    if (out.code !== 0) return out;
    for (const o of items) { const rec = mpr.store.getRecord(o.id); if (rec) { rec.autopilot_handled = new Date().toISOString(); mpr.store.putRecord(rec); } }
    if (out.session_id) rememberSession(mpr, thread, out.session_id);
    // Anything the person should know comes back as "FOR <name>: …" lines.
    for (const line of out.stdout.split("\n").filter((l) => /^\s*FOR\b/i.test(l)).slice(0, 3)) mpr.notify("Your AI", line.replace(/^\s*FOR\s+[^:]*:\s*/i, ""));
  }
  return null;
}

/** Keep the session id for a conversation, so the next wake-up resumes it. Only the most recent MAX_SESSIONS are kept. */
function rememberSession(mpr, thread, session_id) {
  mpr.store.patchState((st) => {
    const sessions = { ...(st.autopilot_sessions || {}), [thread]: { session_id, used: new Date().toISOString() } };
    const kept = Object.entries(sessions).sort((a, b) => (a[1].used < b[1].used ? 1 : -1)).slice(0, MAX_SESSIONS);
    st.autopilot_sessions = Object.fromEntries(kept);
  });
}

/** `claude -p --output-format json`: the answer is in `result` and `session_id` names the session to resume. Plain text is accepted too. */
export function parseRun(code, stdout, stderr) {
  try {
    const j = JSON.parse(stdout);
    if (j && typeof j === "object" && "result" in j) {
      return { code: j.is_error ? 1 : code, stdout: String(j.result ?? ""), stderr, session_id: j.session_id || null };
    }
  } catch {}
  return { code, stdout, stderr, session_id: null };
}

function runClaude({ cfg, skill, model, cwd, principal, thread, session }) {
  const prompt =
    `You answer notes from other people's AIs for ${principal}, who is away. Call mpr_inbox and handle every note on conversation ${thread} in new_notes and waiting_for_your_reply: ` +
    `reply with mpr_send on the same thread when you can answer from what the note and the conversation (mpr_thread) tell you; otherwise reply that ${principal} will see it when they're back, without promising when they'll answer or what they'll decide, ` +
    `or mpr_inbox {"close": "<id>"} if no reply is needed. ${RULE} ` +
    `Finish with one line per note. If ${principal} needs to know or decide something, start that line with "FOR ${principal}:".`;
  // The prompt goes in on stdin, so no shell quoting can mangle it (matters on Windows).
  const args = ["-p", "--output-format", "json", "--model", model, "--mcp-config", cfg, "--strict-mcp-config", "--disable-slash-commands",
    ...(session ? ["--resume", session] : []),
    "--allowedTools", ...AUTOPILOT_TOOLS.map((t) => `mcp__mpr__${t}`),
    "--disallowedTools", ...TOOLS.filter((t) => !AUTOPILOT_TOOLS.includes(t)).map((t) => `mcp__mpr__${t}`), "Bash", "Write", "Edit", "Read", "Glob", "Grep", "NotebookEdit", "Task", "WebFetch", "WebSearch", "Agent"];
  if (skill) args.push("--append-system-prompt-file", skill);
  return new Promise((resolve) => {
    // On Windows the claude CLI is a .cmd shim, which needs a shell to launch.
    const win = process.platform === "win32";
    const q = (a) => (win && /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    // Resolve each time: the desktop app's own copy moves when the app updates.
    resetClaudeBin();
    const bin = claudeBin() || (win ? "claude.cmd" : "claude");
    const sh = win && !path.isAbsolute(bin);
    const p = spawn(bin, sh ? args.map(q) : args, { cwd, env: process.env, shell: sh });
    p.stdin.on("error", () => {});
    p.stdin.end(prompt);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve(parseRun(code, stdout, stderr)));
    p.on("error", (e) => resolve({ code: -1, stdout: "", stderr: e.message, session_id: null }));
  });
}
