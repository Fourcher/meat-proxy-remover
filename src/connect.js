// `mpr connect <code> --name "<human>"` — the one command a recipient's AI runs after its human says yes.
// Redeems the invite, registers the MCP server with Claude Code, and pre-approves ONLY the MPR tools,
// so the two AIs can finish without further prompts.
import { claudeBin } from "./claudebin.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MPR_ROOT } from "./core/store.js";
import { adoptCurrentPackage } from "./core/update.js";
import { TRUST } from "./core/meta.js";
import { TOOLS } from "./core/tools.js";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "server.js");
const CLI = path.join(here, "cli.js");

export function cliCommand() {
  const bin = path.join(MPR_ROOT, "app", "node_modules", ".bin", "mpr");
  return fs.existsSync(bin) ? bin : `node ${CLI}`;
}

// The claude CLI is a plain executable on macOS/Linux and a .cmd shim on Windows (which needs a shell).
const WIN = process.platform === "win32";
// With shell:true, Windows needs each argument quoted by hand (paths like C:\Users\Jane Doe\.mpr).
const winQuote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
const claude = (args, opts = {}) => { const bin = claudeBin(); const sh = WIN && !path.isAbsolute(bin); return execFileSync(bin, sh ? args.map(winQuote) : args, { shell: sh, ...opts }); };
const hasClaude = () => !!claudeBin();
function claudeDir() {
  const bin = claudeBin();
  if (bin && path.isAbsolute(bin)) return path.dirname(bin);
  try { return path.dirname(execFileSync(WIN ? "where" : "which", ["claude"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]); } catch { return ""; }
}

function registerMcp(home, loader) {
  if (!hasClaude()) return { registered: false, reason: "Claude Code not found (neither the claude command nor the Claude desktop app)" };
  try { claude(["mcp", "remove", "mpr", "-s", "user"], { stdio: "ignore" }); } catch {}
  claude(["mcp", "add", "-s", "user", "mpr", "-e", `MPR_HOME=${home}`, "-e", `MPR_ROOT=${MPR_ROOT}`, "--", process.execPath, loader, "server"], { stdio: "ignore" });
  return { registered: true, name: "mpr", scope: "user" };
}

// macOS: keep this side's threads moving while no Claude session is open (model-free polling,
// wakes `claude -p` only when a message needs an answer). Auto-updates itself via the loader.
function installAutopilot(home, loader) {
  if (!hasClaude()) return { installed: false, reason: "needs the claude CLI (Claude Code)" };
  if (os.platform() === "linux") return installAutopilotLinux(home, loader);
  if (os.platform() === "win32") return installAutopilotWindows(home, loader);
  if (os.platform() !== "darwin") return { installed: false, reason: `no background helper for ${os.platform()} yet; threads move while a session is open` };
  const label = "com.meatproxyremover.autopilot";
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const log = path.join(MPR_ROOT, "autopilot.log");
  const PATH = [claudeDir(), path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${loader}</string><string>autopilot</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${PATH}</string><key>MPR_HOME</key><string>${home}</string><key>MPR_ROOT</key><string>${MPR_ROOT}</string>
  </dict>
  <key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`);
  const uid = String(process.getuid());
  try { execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" }); } catch {}
  // bootout is asynchronous: wait for the old instance to go, then load with retries (avoids "Bootstrap failed: 5").
  const loaded = () => { try { execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" }); return true; } catch { return false; } };
  for (let i = 0; i < 20 && loaded(); i++) execFileSync("sleep", ["0.5"]);
  for (let i = 0; i < 5 && !loaded(); i++) {
    try { execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" }); } catch { execFileSync("sleep", ["2"]); }
  }
  if (!loaded()) return { installed: false, reason: "launchd would not load the autopilot; run mpr connect again or mpr doctor" };
  return { installed: true, label, log };
}

// Linux: a systemd user service (no root). Falls back to "not installed" where there's no user systemd (containers, WSL1).
export function linuxUnit(home, loader, PATH) {
  return `[Unit]
Description=Meat Proxy Remover autopilot (keeps AI-to-AI threads moving)
After=network-online.target

[Service]
ExecStart="${process.execPath}" "${loader}" autopilot
Environment="MPR_HOME=${home}" "MPR_ROOT=${MPR_ROOT}" "PATH=${PATH}"
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
}
function installAutopilotLinux(home, loader) {
  try { execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore" }); }
  catch { return { installed: false, reason: "no systemd user session here; threads move while a session is open" }; }
  const PATH = [claudeDir(), path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  const unit = path.join(dir, "meatproxyremover-autopilot.service");
  fs.writeFileSync(unit, linuxUnit(home, loader, PATH));
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync("systemctl", ["--user", "enable", "--now", "meatproxyremover-autopilot.service"], { stdio: "ignore" });
    return { installed: true, unit };
  } catch (e) { return { installed: false, reason: "systemd refused the user service: " + e.message.split("\n")[0], unit }; }
}

// Windows: a per-user scheduled task that starts at logon and runs hidden. No admin rights needed.
export function windowsTaskArgs(home, loader) {
  const q = (v) => String(v).replace(/'/g, "''"); // PowerShell single-quote escaping (paths like O'Brien)
  const cmd = `powershell -NoProfile -WindowStyle Hidden -Command "$env:MPR_HOME='${q(home)}'; $env:MPR_ROOT='${q(MPR_ROOT)}'; & '${q(process.execPath)}' '${q(loader)}' autopilot"`;
  return ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", "MeatProxyRemover Autopilot", "/TR", cmd];
}
function installAutopilotWindows(home, loader) {
  try {
    execFileSync("schtasks", windowsTaskArgs(home, loader), { stdio: "ignore" });
    try { execFileSync("schtasks", ["/Run", "/TN", "MeatProxyRemover Autopilot"], { stdio: "ignore" }); } catch {}
    return { installed: true, task: "MeatProxyRemover Autopilot" };
  } catch (e) { return { installed: false, reason: "Task Scheduler refused: " + e.message.split("\n")[0] }; }
}

export { AUTOPILOT_TOOLS } from "./core/tools.js";
const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
const MCP_PREFIX = "mcp__mpr__";
// Pre-approvals that no longer match a tool: names from older versions, and the old everything-rule.
const isStaleMprRule = (r) => typeof r === "string" && (r === "mcp__mpr" || (r.startsWith(MCP_PREFIX) && !TOOLS.includes(r.slice(MCP_PREFIX.length))));


// Claude Code Stop hook: a session that ends its turn with an MPR task open keeps listening (src/stophook.js), so a
// lazy or early-stopping AI can't drop the task. Runs in the background (asyncRewake) and costs no tokens while it waits.
// Quote for the shell Claude Code runs hooks in: POSIX sh, or cmd on Windows.
const sq = (v) => WIN ? `"${String(v).replace(/"/g, '""')}"` : `'${String(v).replace(/'/g, `'\\''`)}'`;
export function stopHookCommand(home, entry = process.argv[1], { sync = false } = {}) {
  const viaLoader = path.basename(entry) === "loader.mjs";
  const script = viaLoader ? entry : path.join(path.dirname(entry), "cli.js");
  return `${sq(process.execPath)} ${sq(script)}${viaLoader ? " cli" : ""} stop-hook --home ${sq(home)}${sync ? " --sync" : ""}`;
}
const isMprStopHook = (h) => typeof h?.command === "string" && (/MPR_HOME=.* stop-hook( --sync)?$/.test(h.command) || / stop-hook --home .+$/.test(h.command));
function ensureStopHook(settings, home, entry, { sync = false } = {}) {
  if (!home) return false;
  const want = sync ? { type: "command", command: stopHookCommand(home, entry, { sync }), timeout: 600 }
    : { type: "command", command: stopHookCommand(home, entry), asyncRewake: true, timeout: 7800 }; // two-hour listens (tested)
  settings.hooks ||= {};
  const groups = (settings.hooks.Stop ||= []);
  const mine = groups.flatMap((g) => g.hooks || []).filter(isMprStopHook);
  if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(want)) return false;
  for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !isMprStopHook(h));
  settings.hooks.Stop = groups.filter((g) => g.hooks.length);
  settings.hooks.Stop.push({ hooks: [want] });
  return true;
}

// Claude Code on the web reads neither user plugins nor a background hook's wake-up after its VM pauses, but it does
// read the project's .claude/settings.local.json (git-ignored by Claude Code). There the hook runs in --sync mode.
export function ensureCloudStopHook(home, entry = process.argv[1], dir = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  if (process.env.CLAUDE_CODE_REMOTE !== "true" || !home) return { changed: false };
  const file = path.join(dir, ".claude", "settings.local.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (!ensureStopHook(settings, home, entry, { sync: true })) return { changed: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return { changed: true, file };
}

function allowTools(bin, home, loader) {
  const file = settingsFile();
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  settings.permissions ||= {};
  settings.permissions.allow ||= [];
  // Pre-approve MPR's own tools, so two AIs can pass notes without a permission prompt for each one.
  const rules = [...TOOLS.map((t) => `${MCP_PREFIX}${t}`), `Bash(${bin} call:*)`, `Bash(${bin} doctor:*)`, `Bash(${bin} update:*)`];
  settings.permissions.allow = settings.permissions.allow.filter((r) => !isStaleMprRule(r));
  const added = rules.filter((r) => !settings.permissions.allow.includes(r));
  settings.permissions.allow.push(...added);
  const hook = ensureStopHook(settings, home, loader);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return { file, added, stop_hook: hook || undefined };
}

/**
 * After an update, renamed or removed MPR tools must not stay approved and the new names must be. Only touches
 * settings of an install that already has MPR approvals, so nothing is created for a fresh machine.
 */
export function refreshAllowRules(home = process.env.MPR_HOME) {
  const file = settingsFile();
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { changed: false }; }
  const allow = settings.permissions?.allow;
  // Only an install that already has MPR approvals (CLI-registered or the plugin), or a server Claude Code started.
  const hasMpr = Array.isArray(allow) && allow.some((r) => typeof r === "string" && /^mcp__(mpr|plugin_meat-proxy-remover)/.test(r));
  if (!hasMpr) return { changed: false };
  const next = allow.filter((r) => !isStaleMprRule(r));
  for (const t of TOOLS) if (!next.includes(`${MCP_PREFIX}${t}`)) next.push(`${MCP_PREFIX}${t}`);
  // Keep an existing MPR stop hook current; never add one here. Adding it is part of install/connect, which a person
  // (or their AI, with their OK) runs on purpose, so a safety check or a "no" can't be bypassed by an auto-update.
  const hasHook = (settings.hooks?.Stop || []).some((g) => (g.hooks || []).some(isMprStopHook));
  const hook = hasHook && ensureStopHook(settings, home);
  if (JSON.stringify(next) === JSON.stringify(allow) && !hook) return { changed: false };
  settings.permissions.allow = next;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return { changed: true, file };
}

// Everything that makes MPR usable from Claude after the identity exists: managed install (signed auto-updates),
// MCP registration, the skill, MPR-only allow rules, and the macOS autopilot. scope "none" = identity + CLI only.
function installLocal(mpr, scope) {
  const managed = adoptCurrentPackage(); // <root>/loader.mjs + current.json + bin/mpr → signed auto-updates
  const bin = managed.cli;
  const why = `skipped: install scope is "none" (${process.env.MPR_INSTALL_SCOPE === "none" ? "MPR_INSTALL_SCOPE=none in the environment" : "--scope none"}); threads advance only while a session is open`;
  let mcp = { registered: false, reason: why };
  let perms = { added: [] };
  let skill = { installed: false, reason: why };
  let autopilot = { installed: false, reason: why };
  if (scope === "user") {
    try { mcp = registerMcp(mpr.store.home, managed.loader); } catch (e) { mcp = { registered: false, reason: e.message }; }
    // Only touch Claude's settings when there's a Claude install we actually registered with.
    if (mcp.registered) {
      try { perms = allowTools(bin, mpr.store.home, managed.loader); } catch (e) { perms = { error: e.message }; }
      try { const c = ensureCloudStopHook(mpr.store.home, managed.loader); if (c.changed) perms.cloud_stop_hook = c.file; } catch {}
      try { skill = installSkill(); } catch (e) { skill = { installed: false, reason: e.message }; }
    } else {
      perms = { added: [], skipped: "no Claude Code registration, so Claude settings were left untouched" };
      skill = { installed: false, reason: "no Claude Code registration" };
    }
    if (process.env.MPR_NO_AUTOPILOT) autopilot = { installed: false, reason: "MPR_NO_AUTOPILOT set" };
    else try { autopilot = installAutopilot(mpr.store.home, managed.loader); } catch (e) { autopilot = { installed: false, reason: e.message }; }
  }
  return { data_dir: mpr.store.home, mcp, skill, permissions: perms, cli: bin, autopilot, auto_update: "on (signed releases, rollback on failure)" };
}

// The playbook as a Claude Code skill, so "use MPR to …" works in any later session.
function installSkill() {
  const src = path.join(here, "..", "plugin", "skills", "meat-proxy-remover", "SKILL.md");
  if (!fs.existsSync(src)) return { installed: false, reason: "skill file not in this package" };
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills", "meat-proxy-remover");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, "SKILL.md"));
  return { installed: true, path: dir };
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "me";

/** `mpr install --name "<human>"`: everything a fresh AI needs, in one command. Safe to re-run. */
export async function install(mpr, { name, handle, relay, scope = process.env.MPR_INSTALL_SCOPE || "user" }) {
  const existing = mpr.store.getIdentity();
  if (!existing && !name) throw new Error('Usage: mpr install --name "<your human\'s name>"  (ask them; people they connect with will see it)');
  const setup = await mpr.setup({ principal: name || existing?.principal, handle: handle || (existing ? undefined : `${slug(name)}-${crypto.randomBytes(2).toString("hex")}`),
    relay: relay || existing?.transports?.relay || TRUST.maintainer_card?.transports?.relay });
  const reg = setup.relay_registration;
  if (reg && reg.ok === false) throw new Error(`Relay registration failed: ${reg.error || `${reg.status} ${reg.detail}`}. Re-run with --handle <another-name>, or run mpr doctor.`);
  const inst = installLocal(mpr, scope);
  return {
    installed: true,
    you_are: setup.you,
    install: inst,
    tell_your_human: `Meat Proxy Remover is installed. Say "use MPR to ask <person>'s AI about <thing>" and I'll pass notes with their AI directly, so you don't have to copy anything between us.`,
    next: `In THIS session, call tools through the shell: "${inst.cli}" call <tool> '<json>' (e.g. mpr_invite, mpr_inbox).${inst.mcp.registered ? " From the next session the mpr_* tools load directly." : ""}`,
  };
}

export async function connect(mpr, { code, name, handle, approval, scope = process.env.MPR_INSTALL_SCOPE || "user" }) {
  if (!code) throw new Error('Usage: mpr connect "<mpr1:… code>" --name "<your human\'s name>"');
  const accepted = await mpr.acceptInvite({ code, principal: name, handle, approval });
  const inst = installLocal(mpr, scope);
  const to = accepted.connected_to.handle, thread = accepted.their_note?.thread;
  return {
    ...accepted,
    install: inst,
    next: `Reply to their note now. In THIS session use the shell: "${inst.cli}" call mpr_send '{"to":"${to}","thread":"${thread}","text":"…"}', ` +
      `then "${inst.cli}" call mpr_inbox '{"wait_sec":600,"thread":"${thread}"}'. Keep going until it's done, then tell your human the result.${inst.mcp.registered ? " From the next session the mpr_* tools load directly." : ""}`,
  };
}
