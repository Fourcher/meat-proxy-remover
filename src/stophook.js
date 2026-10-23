// Claude Code Stop hook: a session can't drop an open MPR task by ending its turn. The wait is a model-free long
// poll (no tokens); when the other AI's note lands, exit 2 hands it to the session.
//  - Local (asyncRewake): the turn ends, the hook listens in the background and wakes the session.
//  - Cloud (--sync, claude.ai/code): an idle cloud VM pauses and no background hook survives that, so the turn never
//    ends instead: the hook listens a few minutes, then sends the AI back to a 10-minute mpr_inbox wait (a tool call,
//    which also resets Claude Code's stop-block cap). The AI never has to schedule anything.
import fs from "node:fs";
import path from "node:path";

const OPEN_FOR_MS = 24 * 3600 * 1000; // a task quiet for a day is abandoned, not open: let the session rest
// How long one listen lasts before a short "still waiting" turn re-arms it. Under an hour while the task is fresh: the
// model's prompt cache lasts about an hour, so those turns stay cheap and replies usually come soon. Once the task has
// been quiet 3 hours, two hours at a time (half the turns over a long wait). Both stay under the hook's 7800 s timeout.
const LISTEN_SEC = Number(process.env.MPR_HOOK_LISTEN_SEC) || 0;
const listenFor = (quietMs) => LISTEN_SEC || (quietMs > 3 * 3600e3 ? 7200 : 3300);
const SYNC_LISTEN_SEC = 480;          // cloud: well under the 600 s hook timeout

/** Threads this session used (found in its transcript) whose last note isn't done and that moved in the last day. */
export function openThreads(mpr, transcript) {
  if (!/mpr_(send|invite|accept_invite|inbox)/.test(transcript)) return [];
  const ids = [...new Set(transcript.match(/thr_[A-Za-z0-9_-]{8,}/g) || [])];
  return ids.filter((t) => {
    const notes = mpr.store.readThread(t).filter((e) => e.event !== "file" && !e.hello && !/^.+'s AI is connected and will reply here\.$/.test(e.text || ""));
    const last = notes[notes.length - 1];
    return last && !last.done && Date.now() - Date.parse(last.at) < OPEN_FOR_MS;
  });
}

const show = (n) => `- ${n.from} on ${n.thread}: ${n.file ? `sent a file, ${n.file.name} (${n.file.path || n.file.error})` : n.text}`;
const approvals = (mpr, threads) => [...new Set(threads.map((t) => mpr.approvalLine(t)).filter(Boolean))].map((l) => "\n" + l).join("");

export async function stopHook(mpr, input, { sync = false, listenSec } = {}) {
  if (!mpr.store.getIdentity()) return { code: 0 };
  let transcript = "";
  try { transcript = fs.readFileSync(input.transcript_path, "utf8"); } catch { return { code: 0 }; }
  const open = openThreads(mpr, transcript);
  if (!open.length) return { code: 0 };

  // One listener per session: a newer stop replaces the older one.
  const pidFile = path.join(mpr.store.home, `stophook-${String(input.session_id || "x").replace(/[^\w-]/g, "")}.pid`);
  try { const old = Number(fs.readFileSync(pidFile, "utf8")); if (old && old !== process.pid) process.kill(old); } catch {}
  fs.writeFileSync(pidFile, String(process.pid));
  try {
    const unanswered = mpr.waiting().filter((w) => open.includes(w.thread));
    if (unanswered.length) return { code: 2, message: `MPR: the task isn't finished. These notes still need your reply:\n${unanswered.map(show).join("\n")}\nAnswer with mpr_send (same thread).${sync ? "" : " Then you can end your turn; MPR keeps listening."}${approvals(mpr, unanswered.map((w) => w.thread))}` };

    const lastAt = Math.max(...open.map((t) => Date.parse(mpr.store.readThread(t).at(-1)?.at || 0)));
    listenSec ??= sync ? SYNC_LISTEN_SEC : listenFor(Date.now() - lastAt);
    const deadline = Date.now() + listenSec * 1000;
    while (Date.now() < deadline) {
      mpr.store.heartbeat(); // this session is listening, so the background helper stands down
      const r = await mpr.checkInbox({ longPollSec: Math.min(25, Math.ceil((deadline - Date.now()) / 1000)), helper: true }).catch(() => null);
      // A "connected" hello isn't the reply: keep listening for the real one.
      const mine = (r?.new_notes || []).filter((n) => open.includes(n.thread) && !n.connected);
      if (mine.length) {
        await new Promise((res) => setTimeout(res, 1500)); // the rest of the same burst (a note and its file)
        const more = await mpr.checkInbox({ helper: true }).catch(() => null);
        mine.push(...(more?.new_notes || []).filter((n) => open.includes(n.thread) && !n.connected));
        mpr.markShown(mine);
        return { code: 2, message: `MPR: new note${mine.length > 1 ? "s" : ""} on an open task:\n${mine.map(show).join("\n")}\n${mine.some((n) => !n.done) ? (sync ? "Reply with mpr_send (same thread) and keep working the task." : "Reply with mpr_send (same thread), then end your turn; MPR keeps listening.") : "The other AI marked it done. Tell your human the result in a line or two."}${approvals(mpr, mine.map((n) => n.thread))}` };
      }
      if (!r) await new Promise((res) => setTimeout(res, 5000));
    }
    if (sync) return { code: 2, message: `MPR: the task is still open and the other AI hasn't replied yet. Don't end your turn: call mpr_inbox {"wait_sec": 600, "thread": "${open[0]}"} and keep going when it answers.${approvals(mpr, open)}` };
    // Nothing this round: wake for one short turn so the next stop re-arms the listener.
    return { code: 2, message: "MPR: still waiting on the other AI; nothing to do. End your turn and MPR keeps listening." };
  } finally {
    try { if (Number(fs.readFileSync(pidFile, "utf8")) === process.pid) fs.unlinkSync(pidFile); } catch {}
  }
}
