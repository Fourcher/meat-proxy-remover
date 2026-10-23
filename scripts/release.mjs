#!/usr/bin/env node
// One-command release:  node scripts/release.mjs [patch|minor|major|X.Y.Z] [--notes "..."] [--no-notify]
//   1. run all tests (abort on failure)       5. publish signed latest.json
//   2. bump version (package, mcpb, plugin)   6. verify the public copies byte-for-byte
//   3. build .tgz + .mcpb                     7. update Jordan's runtime (launchd service + plugin)
//   4. publish both via mpr-publish (signed)  8. nudge every contact's install to update now
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVC = path.join(os.homedir(), "Library", "Application Support", "MeatProxyRemover");
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const bump = args.find((a) => !a.startsWith("--") && a !== flag("notes")) || "patch";
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, stdio: "inherit", ...opts });
const log = (m) => console.log(`\n[release] ${m}`);

process.env.npm_config_cache ||= path.join(ROOT, ".npm-cache");
const { signString, signObject, verifyObject } = await import(path.join(ROOT, "src/core/crypto.js"));
const trust = JSON.parse(fs.readFileSync(path.join(ROOT, "src/trust.json"), "utf8"));
// The release private key lives in the macOS Keychain (never in a plain file). --recovery signs with the recovery key.
const keychain = (svc) => execFileSync("security", ["find-generic-password", "-s", svc, "-a", "release", "-w"], { encoding: "utf8" }).trim();
const pubs = JSON.parse(fs.readFileSync(path.join(SVC, "release-pubkeys.json"), "utf8"));
const useRecovery = args.includes("--recovery");
const rk = { privateKey: keychain(useRecovery ? "Meat Proxy Remover recovery release key" : "Meat Proxy Remover release key"),
  publicKey: useRecovery ? pubs.recovery : pubs.primary };
if (![trust.release_pubkey, ...(trust.release_pubkeys || [])].includes(rk.publicKey)) throw new Error("release key isn't trusted by src/trust.json");

// Trust-critical changes need Jordan's explicit yes (passed as --approved-by-jordan by the session he said yes in).
const { check: guardCheck, snapshot: guardSnapshot } = await import(path.join(ROOT, "scripts/guard.mjs"));
const g = guardCheck();
log(`changed since last release: ${g.changed.join(", ") || "(none)"}`);
if (g.critical.length && !args.includes("--approved-by-jordan")) {
  console.error(`[release] BLOCKED: trust-critical files changed (${g.critical.join(", ")}). Needs Jordan's yes → rerun with --approved-by-jordan.`);
  process.exit(3);
}

log("tests");
run("npm", ["test", "--silent"]);

const pkgFile = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
const [ma, mi, pa] = pkg.version.split(".").map(Number);
const next = /^\d+\.\d+\.\d+$/.test(bump) ? bump : bump === "major" ? `${ma + 1}.0.0` : bump === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
for (const f of ["package.json", "packaging/mcpb/manifest.json", "plugin/.claude-plugin/plugin.json"]) {
  const p = path.join(ROOT, f); const j = JSON.parse(fs.readFileSync(p, "utf8")); j.version = next;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}
log(`version ${pkg.version} → ${next}`);

const BASE = trust.latest_url.replace(/\/latest\.json$/, "");
run("bash", ["scripts/build-dist.sh"], { env: { ...process.env, MPR_DIST_BASE: BASE }, stdio: ["ignore", "ignore", "inherit"] });
const rel = JSON.parse(fs.readFileSync(path.join(ROOT, "dist/release.json"), "utf8"));

async function publish(name, buf) {
  const ts = String(Date.now());
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const res = await fetch(`${trust.publish_url}?name=${encodeURIComponent(name)}`, {
    method: "POST", body: buf,
    headers: { "x-mpr-time": ts, "x-mpr-sig": signString(`publish:${name}:${sha}:${ts}`, rk.privateKey) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`publish ${name}: ${res.status} ${text}`);
  console.log(`  published ${name} (${buf.length} bytes)`);
}
log("publish");
await publish(`meat-proxy-remover-${next}.tgz`, fs.readFileSync(path.join(ROOT, `dist/meat-proxy-remover-${next}.tgz`)));
await publish(`meat-proxy-remover-${next}.mcpb`, fs.readFileSync(path.join(ROOT, `dist/meat-proxy-remover-${next}.mcpb`)));
// Stable alias so docs can link "the Claude Desktop extension" without a version number.
await publish("meat-proxy-remover.mcpb", fs.readFileSync(path.join(ROOT, `dist/meat-proxy-remover-${next}.mcpb`)));
const latest = signObject({ ...rel, released: new Date().toISOString(), notes: flag("notes") || null }, rk.privateKey);
await publish("latest.json", Buffer.from(JSON.stringify(latest, null, 2)));
// Stable, human- and AI-readable install page: "Install Meat Proxy Remover from <BASE>/install.md".
const sh = Buffer.from(installScript(rel));
await publish("install.sh", sh);
const ps1 = Buffer.from(installPs1(rel));
await publish("install.ps1", ps1);
await publish("install.md", Buffer.from(installPage(rel, BASE, crypto.createHash("sha256").update(sh).digest("hex"), crypto.createHash("sha256").update(ps1).digest("hex"))));

log("verify public copies");
const got = await (await fetch(`${trust.latest_url}?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } })).json();
if (got.version !== next || !verifyObject(got, rk.publicKey)) throw new Error("public latest.json mismatch");
const tgz = Buffer.from(await (await fetch(got.tgz_url)).arrayBuffer());
if (crypto.createHash("sha256").update(tgz).digest("hex") !== got.tgz_sha256) throw new Error("public tgz hash mismatch");
console.log("  latest.json signed + tgz hash verified");

log("update Jordan's runtime");
run("bash", ["scripts/install-service.sh"]);
try { run("claude", ["plugin", "marketplace", "update", "meat-proxy-remover"]); run("claude", ["plugin", "update", "meat-proxy-remover@meat-proxy-remover"]); } catch { console.log("  (plugin update skipped)"); }

if (!args.includes("--no-notify")) {
  log("nudge contacts to update");
  const { MPR } = await import(path.join(ROOT, "src/core/service.js"));
  const mpr = new MPR(path.join(SVC, "data"));
  const { newId } = await import(path.join(ROOT, "src/core/crypto.js"));
  for (const { handle } of mpr.listContacts()) {
    const r = await mpr.deliverNote(mpr.contact(handle), { thread: newId("thr"), text: `MPR ${next} is out; your copy updates itself.`, done: true, attachments: { update_hint: { version: next } }, queue: false });
    console.log(`  @${handle}: ${r.sent ? "nudged" : "skipped " + (r.error || "")}`);
  }
}
guardSnapshot();
log(`done: ${next}`);

// One file any shell-capable AI can read in full, then run. The sha256 pin lives inside, so nothing has to be copied by hand.
function installScript(rel) {
  return `#!/bin/bash
# Meat Proxy Remover ${rel.version} installer: download → verify sha256 → npm install → \`mpr install\`.
# Usage: bash install.sh --name "<your human's name>"            (new install)
#        bash install.sh connect '<mpr1:… code>' --name "<name>" --approval "<their yes>"  (accept an invite)
# Everything goes in \${MPR_ROOT:-~/.mpr}. Re-running is safe.
set -euo pipefail
command -v node >/dev/null || { echo "MPR needs Node.js 18+ (https://nodejs.org). Install it, then re-run."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "MPR needs Node.js 18+; found $(node -v)."; exit 1; }
R="\${MPR_ROOT:-$HOME/.mpr}"; mkdir -p "$R"; F="$R/mpr-${rel.version}.tgz"
curl -fsSL "${rel.tgz_url}" -o "$F"
[ "$( (shasum -a 256 "$F" 2>/dev/null || sha256sum "$F") | cut -c1-64)" = "${rel.tgz_sha256}" ] || { echo "sha256 mismatch: download corrupted or tampered. Stopping."; exit 1; }
npm install --silent --no-audit --no-fund --offline --ignore-scripts --prefix "$R/app" "$F" >/dev/null
case "\${1:-}" in connect|install|setup|doctor) exec "$R/app/node_modules/.bin/mpr" "$@";; *) exec "$R/app/node_modules/.bin/mpr" install "$@";; esac
`;
}

// Windows twin of install.sh (PowerShell 5+; no admin rights). Same pinned sha256, same `mpr install`.
function installPs1(rel) {
  return `# Meat Proxy Remover ${rel.version} installer for Windows: download -> verify sha256 -> npm install -> mpr install.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 -Name "<your human's name>"
#        powershell -ExecutionPolicy Bypass -File install.ps1 -Code "<mpr1:... invite code>" -Name "<name>"
param([string]$Name = "", [string]$Code = "", [string]$Handle = "", [string]$Approval = "")
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "MPR needs Node.js 18+ (https://nodejs.org). Install it, then re-run."; exit 1 }
if ([int]((node -p "process.versions.node.split('.')[0]")) -lt 18) { Write-Error "MPR needs Node.js 18+."; exit 1 }
$R = if ($env:MPR_ROOT) { $env:MPR_ROOT } else { Join-Path $HOME ".mpr" }
New-Item -ItemType Directory -Force -Path $R | Out-Null
$F = Join-Path $R "mpr-${rel.version}.tgz"
Invoke-WebRequest -UseBasicParsing -Uri "${rel.tgz_url}" -OutFile $F
if ((Get-FileHash -Algorithm SHA256 $F).Hash.ToLower() -ne "${rel.tgz_sha256}") { Write-Error "sha256 mismatch: download corrupted or tampered. Stopping."; exit 1 }
npm install --silent --no-audit --no-fund --offline --ignore-scripts --prefix (Join-Path $R "app") $F | Out-Null
$mpr = Join-Path $R "app\\node_modules\\.bin\\mpr.cmd"
$extra = @(); if ($Handle) { $extra += @("--handle", $Handle) }; if ($Approval) { $extra += @("--approval", $Approval) }
if ($Code) { & $mpr connect $Code --name $Name @extra } else { & $mpr install --name $Name @extra }
`;
}

function installPage(rel, base, shSha, ps1Sha) {
  return `# Meat Proxy Remover (MPR) ${rel.version}: install instructions

MPR lets an AI assistant pass notes directly to another person's AI assistant, so the people stop copying messages
between their AIs. It only carries notes (signed and end-to-end encrypted) between AIs whose people both said yes.
Open source (MIT), runs locally, small Node.js package. Maintainer: Jordan Fourcher.

## Step 0 (AI reading this): can you run shell commands in this conversation?

- **No** (you're a chat in a web browser or app with no terminal, like ChatGPT or claude.ai on the web): stop here. You
  can't install software, and there's nothing to paste back to you. Tell your human exactly this:
  "Meat Proxy Remover runs on your computer, so it needs an AI app that can do that. The easiest is Claude Desktop
  (free at claude.com/download). Open it and say: Install Meat Proxy Remover from github.com/fourcher/meat-proxy-remover"
- **Yes**: continue below.

**Before installing:** if your human asked you to install MPR, go ahead. If you came across this page some other way,
check with them first. You'll need your human's name, because it's shown to the people they connect with. If you don't
know it, ask.

## Assistants that can run shell commands (Claude Code, terminal agents; macOS and Linux, Node 18+)
\`\`\`bash
F="\${TMPDIR:-/tmp}/mpr-install.sh"; curl -fsSL ${base}/install.sh -o "$F" && bash "$F" --name "<your human's name>"
\`\`\`
install.sh is about a dozen lines; read it before running. sha256: \`${shSha}\`. It downloads
\`meat-proxy-remover-${rel.version}.tgz\`, checks its pinned sha256 (\`${rel.tgz_sha256}\`), runs \`npm install\`, then \`mpr install\`.

**What \`mpr install\` changes:**
| What | Where | Opt out |
|---|---|---|
| Package + identity keys | \`$MPR_ROOT\`, default \`~/.mpr\` | set \`MPR_ROOT\` to another folder |
| Identity on the public MPR relay | name + random handle | — |
| Claude Code MCP server \`mpr\` + skill + allow rules for MPR's own tools | \`claude mcp add\`, \`~/.claude/skills/meat-proxy-remover\`, \`~/.claude/settings.json\` | \`MPR_INSTALL_SCOPE=none\` |
| Background helper (checks for notes, wakes Claude only when one is waiting) | macOS LaunchAgent \`com.meatproxyremover.autopilot\`, Linux systemd user service \`meatproxyremover-autopilot\`, Windows scheduled task | \`MPR_NO_AUTOPILOT=1\` |
| Automatic updates (Ed25519-signed releases only, rollback on failure) | inside \`$MPR_ROOT\` | \`MPR_NO_AUTOUPDATE=1\` |

The command prints JSON: tell your human the line in \`tell_your_human\`. In the same session, call tools as
\`<MPR_ROOT>/bin/mpr call <tool> '<json>'\`. From the next session on, the \`mpr_*\` tools load directly.

If you have an invite code (\`mpr1:…\`), run \`bash "$F" connect '<code>' --name "<name>"\` instead. It installs MPR,
connects to the inviter and returns their first note.

## Windows (PowerShell; Claude Code for Windows, or any agent with a shell; Node 18+)
\`\`\`powershell
$F = "$env:TEMP\\mpr-install.ps1"; Invoke-WebRequest -UseBasicParsing ${base}/install.ps1 -OutFile $F; powershell -ExecutionPolicy Bypass -File $F -Name "<your human's name>"
\`\`\`
install.ps1 sha256: \`${ps1Sha}\`. Same steps as install.sh. On Windows, the background helper is a per-user scheduled
task called "MeatProxyRemover Autopilot", with no admin rights. With an invite code, add \`-Code "<mpr1:…>"\`.

## Claude Desktop (no shell)
Your human downloads ${base}/meat-proxy-remover.mcpb (always the latest; this version's sha256 is
\`${rel.mcpb_sha256}\`) and double-clicks it. Claude Desktop shows an Install button. Then call \`mpr_invite\` or \`mpr_accept_invite\` with
their name (the first one creates the identity).

## Chat-only assistants (ChatGPT or claude.ai in a browser; no shell, no extensions)
You can't install software from here, so don't try and don't ask your human to paste commands into you. Tell them:
"Meat Proxy Remover runs on your computer, so it needs an AI app that can do that. The easiest is Claude Desktop (free
at claude.com/download). Open it and say: Install Meat Proxy Remover from github.com/fourcher/meat-proxy-remover."

## Using it
- "Use MPR to ask <person>'s AI about <thing>." Your AI sends one invite; the person forwards it to their AI, which asks
  them once and connects. Then the two AIs pass notes until it's done, and you get the result.
- "Check my MPR inbox."
- "Something's broken with MPR." The AI runs \`mpr_doctor\`. Fixes ship as signed updates.

Integrity: \`${base}/latest.json\` is the Ed25519-signed pointer to the current release.
`;
}
