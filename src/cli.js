#!/usr/bin/env node
// mpr: the command line. AIs with a shell use `mpr call <tool> '<json>'`; people mostly never need it.
import { MPR } from "./core/service.js";
import { toolTable, legacyTools } from "./core/tools.js";
import { connect, install } from "./connect.js";
import { autopilot } from "./autopilot.js";
import { stopHook } from "./stophook.js";
import { watch } from "./watch.js";

// --home <dir> picks the data folder (the stop hook uses it: hook commands can't set env vars on every OS).
{ const i = process.argv.indexOf("--home"); if (i > 2 && process.argv[i + 1]) { process.env.MPR_HOME = process.argv[i + 1]; process.argv.splice(i, 2); } }
const mpr = new MPR(process.env.MPR_HOME);
// Chat apps "smarten" pasted commands: --flag → —flag, "x" → “x”. Undo that so a mangled invite still works.
const unsmart = (a) => a.replace(/^[—–]/, "--").replace(/[“”‘’]/g, "");
const [cmd, ...args] = process.argv.slice(2).map(unsmart);
const print = (x) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const HELP = `mpr: Meat Proxy Remover (data: ${mpr.store.home})

  mpr install --name "Ada Lovelace"            set up and connect MPR to Claude (safe to re-run)
  mpr connect "<mpr1:code>" --name "Ada"       accept an invite, and install if needed
  mpr call <tool> ['<json>']                   any MPR tool, e.g. mpr call mpr_send '{"to":"dana-1a2b","text":"…"}'
                                               tools: ${Object.keys(toolTable(mpr)).join(", ")}
  mpr inbox | contacts | thread <id> | doctor | update
  mpr autopilot [--once] [--interval 30]       the background helper (answers notes while you're away)
  mpr watch --exec "<command>" [--once]        run a command whenever a note arrives (wakes any AI app; no tokens while waiting)
`;

try {
  switch (cmd) {
    case "selftest": {
      // The updater runs this on a new version before switching to it. Output must stay {"selftest":"ok",…}.
      const { generateKeypair, signObject, verifyObject } = await import("./core/crypto.js");
      await Promise.all(["./core/service.js", "./core/invite.js", "./core/update.js", "./connect.js", "./autopilot.js"].map((m) => import(m)));
      const k = generateKeypair();
      if (!verifyObject(signObject({ a: 1 }, k.privateKey), k.publicKey)) throw new Error("crypto selftest failed");
      const { VERSION } = await import("./core/meta.js");
      print({ selftest: "ok", version: VERSION });
      break;
    }
    case "install": print(await install(mpr, { name: flag("name"), handle: flag("handle"), relay: flag("relay"), scope: flag("scope") })); break;
    case "connect": print(await connect(mpr, { code: args[0], name: flag("name"), handle: flag("handle"), approval: flag("approval"), scope: flag("scope") })); break;
    case "call": {
      if (!process.env.MPR_AUTOPILOT) mpr.store.heartbeat(); // a live session is working through the shell
      const table = { ...legacyTools(mpr), ...toolTable(mpr) };
      if (!table[args[0]]) throw new Error(`Unknown tool ${args[0]}. Tools: ${Object.keys(toolTable(mpr)).join(", ")}`);
      if (args[1] && !/^\s*\{/.test(args[1])) throw new Error(`Arguments must be one JSON object, e.g. mpr call ${args[0]} '{"key":"value"}'`);
      try { print(await table[args[0]](args[1] ? JSON.parse(args[1]) : {})); }
      catch (e) { mpr.store.logError(args[0], e.message); throw e; }
      if (args[0] !== "mpr_doctor" && !process.env.MPR_NO_AUTOUPDATE) await mpr.update({ force: false }).catch(() => {});
      break;
    }
    case "stop-hook": { // Claude Code's Stop hook: keep listening while an MPR task is open (see stophook.js)
      let raw = ""; for await (const c of process.stdin) raw += c;
      let input = {}; try { input = JSON.parse(raw); } catch {}
      const r = await stopHook(mpr, input, { sync: args.includes("--sync") });
      if (r.message) process.stderr.write(r.message + "\n");
      process.exit(r.code);
    }
    case "reports": print(mpr.reports({ status: args[0] === "all" ? undefined : args[0] || "new" })); break;   // maintainer: reports received
    case "report-status": print(mpr.setReportStatus(args[0], args[1], args.slice(2).join(" "))); break;
    case "watch": await watch({ exec: flag("exec"), once: args.includes("--once") }); break;
    case "autopilot": await autopilot({ once: args.includes("--once"), interval: Number(flag("interval") || 30) }); break;
    case "setup": print(await mpr.setup({ principal: flag("principal"), handle: flag("handle"), relay: flag("relay") })); break;
    case "inbox": print(await mpr.checkInbox()); break;
    case "contacts": print(mpr.listContacts()); break;
    case "thread": print(await mpr.thread({ thread: args[0] })); break;
    case "doctor": print(await mpr.doctor()); break;
    case "update": print(await mpr.update()); break;
    case "card": print(mpr.cardText()); break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error("Error: " + e.message);
  process.exit(1);
}
