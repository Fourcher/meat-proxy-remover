// `mpr watch --exec "<command>"`: wake any AI app when a note arrives. A model-free long poll (no tokens); for each
// batch of new notes it runs the command once, with the notes in the environment and as JSON on stdin. The notes stay
// unread for the AI, so its next mpr_inbox still returns them. For hosts without Claude Code's hooks or helper
// (LLM OS, a cron-driven agent, a chat bridge): the command is whatever starts or pokes that AI.
import { spawn } from "node:child_process";
import { MPR } from "./core/service.js";

export async function watch({ home = process.env.MPR_HOME, exec, once = false, log = console.error } = {}) {
  if (!exec) throw new Error('Usage: mpr watch --exec "<command to run when a note arrives>"');
  const mpr = new MPR(home);
  const me = mpr.requireIdentity();
  log(`[watch] ${me.principal} (@${me.handle}): runs "${exec}" when a note arrives`);
  const run = (notes) => new Promise((resolve) => {
    const first = notes[0];
    const env = { ...process.env, MPR_HOME: mpr.store.home, MPR_NOTE_COUNT: String(notes.length), MPR_NOTE_FROM: first.from || "",
      MPR_NOTE_THREAD: first.thread || "", MPR_NOTE_TEXT: String(first.text || (first.file ? `sent a file: ${first.file.name}` : "")).slice(0, 4000),
      MPR_NOTE_APPROVED: mpr.approvalLine(first.thread) || "" };
    const p = spawn(exec, { shell: true, env, stdio: ["pipe", "inherit", "inherit"] });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(notes));
    p.on("close", (code) => { log(`[watch] ran for ${notes.length} note(s) from ${first.from}; exit ${code}`); resolve(code); });
    p.on("error", (e) => { log(`[watch] couldn't run the command: ${e.message}`); resolve(-1); });
  });
  // Notes already waiting for an answer when the watcher starts count as new: the AI may never have seen them.
  const pending = mpr.waiting();
  if (pending.length) await run(pending);
  while (true) {
    const r = await mpr.checkInbox({ longPollSec: 25, helper: true }).catch((e) => { log(`[watch] ${e.message}`); return null; });
    const fresh = (r?.new_notes || []).filter((n) => !n.connected);
    if (fresh.length) {
      await new Promise((res) => setTimeout(res, 1500)); // the rest of the burst (a note and its file)
      const more = await mpr.checkInbox({ helper: true }).catch(() => null);
      await run([...fresh, ...(more?.new_notes || []).filter((n) => !n.connected)]);
      if (once) return;
    }
    if (!r) await new Promise((res) => setTimeout(res, 15000));
  }
}
