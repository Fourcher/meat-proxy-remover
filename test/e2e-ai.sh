#!/bin/bash
# Real AIs, end to end: Jordan's AI asks Dana's AI for a quote through MPR. Nobody copies anything except the
# one invite message, which a person would forward.
# Usage: bash test/e2e-ai.sh [jordan-model] [dana-model]
#   models: sonnet | haiku | opus (Claude Code), or codex:<ollama model> (Codex CLI on a local model), e.g. codex:qwen3:8b
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${1:-sonnet}"; DMODEL="${2:-$MODEL}"
S="${S_DIR:-$ROOT/test/e2e-ai-run}"
rm -rf "$S"; mkdir -p "$S/jordan" "$S/dana"
PORT=$((32000 + RANDOM % 500))
MPR_RELAY_DATA="$S/relay" PORT=$PORT node "$ROOT/relay/relay.js" 2>"$S/relay.log" & RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT
sleep 1
URL="http://127.0.0.1:$PORT"
TOOLS="mcp__mpr__mpr_send mcp__mpr__mpr_inbox mcp__mpr__mpr_invite mcp__mpr__mpr_accept_invite mcp__mpr__mpr_thread mcp__mpr__mpr_doctor"
for who in jordan dana; do
  cat > "$S/$who/mcp.json" <<JSON
{"mcpServers":{"mpr":{"command":"node","args":["$ROOT/src/server.js"],"env":{"MPR_HOME":"$S/$who/data","MPR_ROOT":"$S/$who/root","MPR_NO_AUTOUPDATE":"1","MPR_NO_NOTIFY":"1"}}}}
JSON
done
# Identities on the local test relay (a real install uses the public relay automatically).
for who in jordan dana; do
  name=$([ $who = jordan ] && echo "Jordan Fourcher" || echo "Dana Whitfield")
  MPR_HOME="$S/$who/data" MPR_ROOT="$S/$who/root" node "$ROOT/src/cli.js" setup --principal "$name" --handle $who --relay "$URL" >/dev/null
done
SYS="You are in an automated test sandbox. Don't create or edit files. Use only the mpr_* tools."
ai() { # who, prompt
  local m="$MODEL"; [ "$1" = dana ] && m="$DMODEL"
  if [[ "$m" == opencode:* ]]; then
    # opencode (open-source agent) on a local Ollama model, with only the MPR MCP server; no shell, no file edits.
    mkdir -p "$S/$1/oc"
    cat > "$S/$1/oc/opencode.json" <<OCJSON
{ "\$schema": "https://opencode.ai/config.json",
  "provider": { "ollama": { "npm": "@ai-sdk/openai-compatible", "name": "Ollama", "options": { "baseURL": "http://127.0.0.1:11434/v1" },
    "models": { "${m#opencode:}": { "name": "local", "tools": true } } } },
  "model": "ollama/${m#opencode:}",
  "tools": { "mpr_*": true },
  "permission": { "bash": "deny", "edit": "deny", "webfetch": "deny", "mpr_*": "allow" },
  "mcp": { "mpr": { "type": "local", "command": ["node", "$ROOT/src/server.js"], "enabled": true,
    "environment": { "MPR_HOME": "$S/$1/data", "MPR_ROOT": "$S/$1/root", "MPR_NO_AUTOUPDATE": "1", "MPR_NO_NOTIFY": "1" } } } }
OCJSON
    (cd "$S/$1" && OPENCODE_CONFIG="$S/$1/oc/opencode.json" XDG_DATA_HOME="$S/$1/oc/data" XDG_STATE_HOME="$S/$1/oc/state" XDG_CACHE_HOME="$S/$1/oc/cache" \
      "${OPENCODE_BIN:-opencode}" run -m "ollama/${m#opencode:}" "$SYS $2" < /dev/null 2>&1 | tail -40)
  elif [[ "$m" == codex:* ]]; then
    # Codex CLI on a local open model, with only the MPR MCP server; its shell is read-only.
    mkdir -p "$S/$1/codex"
    cat > "$S/$1/codex/config.toml" <<TOML
oss_provider = "ollama"
[mcp_servers.mpr]
command = "node"
args = ["$ROOT/src/server.js"]
env = { MPR_HOME = "$S/$1/data", MPR_ROOT = "$S/$1/root", MPR_NO_AUTOUPDATE = "1", MPR_NO_NOTIFY = "1" }
tool_timeout_sec = 90
TOML
    (cd "$S/$1" && CODEX_HOME="$S/$1/codex" "${CODEX_BIN:-codex}" exec --oss -m "${m#codex:}" -s read-only --skip-git-repo-check "$SYS $2" < /dev/null 2>&1 | tail -40)
  else
    (cd "$S/$1" && claude -p --model "$m" --mcp-config "$S/$1/mcp.json" --strict-mcp-config --permission-mode default \
      --allowedTools $TOOLS --append-system-prompt "$SYS" --output-format text "$2" < /dev/null)
  fi
}

echo "=== 1. Jordan asks his AI ==="
J1=$(ai jordan "Use MPR to ask Dana Whitfield's AI what her price is for 500 gallons of CryoPaint primer, and whether it can be delivered by November 15. Give me the invite message to send her.")
echo "$J1"
CODE=$(echo "$J1" | grep -o 'mpr1:[A-Za-z0-9_-]*' | head -1)
[ -z "$CODE" ] && CODE=$(ls "$S"/jordan/data/records >/dev/null 2>&1; echo "")
[ -z "$CODE" ] && { echo "FAIL: no invite code in Jordan's AI's answer"; exit 1; }

echo; echo "=== 2. Dana forwards the invite to her AI ==="
D1=$(ai dana "Jordan Fourcher sent me this. Yes, go ahead and connect and answer it. Our list price is \$38/gallon, 8% off for orders of 500+ gallons, and lead time is 10 business days from the PO.

Invite code: $CODE")
echo "$D1"

echo; echo "=== 3. Jordan checks back ==="
J2=$(ai jordan "Check my MPR inbox. What did Dana's AI say? Wait a bit if the answer isn't there yet.")
echo "$J2"

echo; echo "=== verdict ==="
ok=1
echo "$J2" | grep -Eq '34\.96|17,?480' || { echo "FAIL: Jordan didn't get the price"; ok=0; }
echo "$J2" | grep -Eiq 'nov(ember)? ?15|lead time|10 business days|business days' || { echo "FAIL: Jordan didn't get the delivery answer"; ok=0; }
[ $ok = 1 ] && echo "PASS ($MODEL ↔ $DMODEL): the AIs passed notes and Jordan got the answer without relaying anything"
exit $((1 - ok))
