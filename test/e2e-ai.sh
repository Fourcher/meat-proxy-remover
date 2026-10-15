#!/bin/bash
# Real AIs, end to end: Jordan's Claude asks Dana's Claude for a quote through MPR. Nobody copies anything except the
# one invite message, which a person would forward. Usage: bash test/e2e-ai.sh [model]   (default sonnet)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${1:-sonnet}"
S="${S_DIR:-$ROOT/test/e2e-ai-run}"
rm -rf "$S"; mkdir -p "$S/jordan" "$S/dana"
PORT=$((32000 + RANDOM % 500))
MPR_RELAY_DATA="$S/relay" PORT=$PORT node "$ROOT/relay/relay.js" 2>"$S/relay.log" & RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT
sleep 1
URL="http://127.0.0.1:$PORT"
TOOLS="mcp__mpr__mpr_send mcp__mpr__mpr_check_inbox mcp__mpr__mpr_wait mcp__mpr__mpr_invite mcp__mpr__mpr_accept_invite mcp__mpr__mpr_thread mcp__mpr__mpr_close mcp__mpr__mpr_files mcp__mpr__mpr_contacts mcp__mpr__mpr_setup mcp__mpr__mpr_doctor"
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
  (cd "$S/$1" && claude -p --model "$MODEL" --mcp-config "$S/$1/mcp.json" --strict-mcp-config --permission-mode default \
    --allowedTools $TOOLS --append-system-prompt "$SYS" --output-format text "$2" < /dev/null)
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
[ $ok = 1 ] && echo "PASS ($MODEL): the AIs passed notes and Jordan got the answer without relaying anything"
exit $((1 - ok))
