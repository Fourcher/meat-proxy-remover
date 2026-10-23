#!/bin/bash
# Real AIs, multi-turn job with a file: Jordan's AI and Anthony's (CFO) AI build a one-page Q3 board update together.
# Jordan has the pilot notes, Anthony has the actuals (a CSV). Several rounds, each started the way a person would.
# Usage: bash test/e2e-onepager.sh [model]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; MODEL="${1:-sonnet}"
S="${S_DIR:-$ROOT/test/e2e-onepager-run}"; rm -rf "$S"; mkdir -p "$S/jordan" "$S/anthony"
PORT=$((33000 + RANDOM % 500)); MPR_RELAY_DATA="$S/relay" PORT=$PORT node "$ROOT/relay/relay.js" 2>"$S/relay.log" & RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT; sleep 1; URL="http://127.0.0.1:$PORT"
for who in jordan anthony; do
  name=$([ $who = jordan ] && echo "Jordan Fourcher" || echo "Anthony Ruiz")
  MPR_HOME="$S/$who/data" MPR_ROOT="$S/$who/root" node "$ROOT/src/cli.js" setup --principal "$name" --handle $who --relay "$URL" >/dev/null
  cat > "$S/$who/mcp.json" <<JSON
{"mcpServers":{"mpr":{"command":"node","args":["$ROOT/src/server.js"],"env":{"MPR_HOME":"$S/$who/data","MPR_ROOT":"$S/$who/root","MPR_NO_AUTOUPDATE":"1","MPR_NO_NOTIFY":"1"}}}}
JSON
done
cat > "$S/jordan/pilot-notes.md" <<'MD'
# Q3 pilot notes (Jordan)
- 3 new enterprise logos: Halvorsen Freight, Marlow Clinics, Sato Robotics
- Why they signed: onboarding in 2 weeks instead of 8
- Ask for the board: approve expanding the pilot to 2 more regions in Q4
MD
cat > "$S/anthony/q3-actuals.csv" <<'CSV'
metric,q2,q3
pilot_revenue_usd,182000,264000
gross_margin_pct,41,47
cac_usd,1900,1450
runway_months,17,19
CSV
TOOLS="mcp__mpr__mpr_send mcp__mpr__mpr_inbox mcp__mpr__mpr_invite mcp__mpr__mpr_accept_invite mcp__mpr__mpr_thread mcp__mpr__mpr_doctor Read Write Edit"
SYS="You are in an automated test sandbox. Only read and write files in the current folder."
ai() { (cd "$S/$1" && claude -p --model "$MODEL" --mcp-config "$S/$1/mcp.json" --strict-mcp-config --permission-mode acceptEdits \
  --allowedTools $TOOLS --append-system-prompt "$SYS" --output-format text "$2" < /dev/null); }

echo "=== 1. Jordan ==="
J1=$(ai jordan "Use MPR to make a one-page Q3 pilot update for the board with Anthony Ruiz's AI. My pilot notes are in ./pilot-notes.md; Anthony's AI has the Q3 actuals. Give me the invite to send Anthony."); echo "$J1" | tail -15
CODE=$(echo "$J1" | grep -o 'mpr1:[A-Za-z0-9_-]*' | head -1); [ -z "$CODE" ] && { echo "FAIL: no invite code"; exit 1; }
echo; echo "=== 2. Anthony forwards the invite ==="
ai anthony "Jordan Fourcher sent me this. Yes, connect and help his AI with the board one-pager. Our Q3 actuals are in ./q3-actuals.csv; send them what they need. Invite code: $CODE" | tail -15
echo; echo "=== 3. Jordan: keep going ==="
ai jordan "Check my MPR inbox and work with Anthony's AI until the one-pager is done. Send him the draft to check the numbers, and save the final as ./q3-one-pager.md." | tail -15
echo; echo "=== 4. Anthony: check the draft ==="
ai anthony "Check your MPR inbox and help Jordan's AI finish: check any draft against ./q3-actuals.csv and reply." | tail -15
echo; echo "=== 5. Jordan: finish ==="
ai jordan "Check MPR once more. If Anthony's AI replied, apply any fixes and finalize ./q3-one-pager.md. Then tell me in two lines where it stands." | tail -15

echo; echo "=== verdict ==="
F="$S/jordan/q3-one-pager.md"; ok=1
[ -f "$F" ] || { echo "FAIL: no one-pager"; ok=0; }
[ -f "$F" ] && { grep -Eq '264(,000|k|K| ?000)|\$264' "$F" || { echo "FAIL: Q3 revenue missing"; ok=0; }; grep -Eq '182' "$F" || { echo "FAIL: Q2 revenue missing"; ok=0; }; grep -q 'Halvorsen' "$F" || { echo "FAIL: pilot wins missing"; ok=0; }; grep -Eq '47' "$F" || { echo "FAIL: margin missing"; ok=0; }; }
N=$(MPR_HOME="$S/anthony/data" MPR_ROOT="$S/anthony/root" node -e 'const {MPR}=await import(process.argv[1]);const m=new MPR(process.env.MPR_HOME);console.log(m.store.listRecords().filter(r=>r.kind==="inbound").length)' "$ROOT/src/core/service.js" --input-type=module 2>/dev/null)
echo "notes Anthony's AI received: $N"; [ "${N:-0}" -ge 2 ] || { echo "FAIL: the draft never reached Anthony's AI"; ok=0; }
J=$(MPR_HOME="$S/jordan/data" MPR_ROOT="$S/jordan/root" node -e 'const {MPR}=await import(process.argv[1]);const m=new MPR(process.env.MPR_HOME);console.log(m.store.listRecords().filter(r=>r.kind==="inbound"&&!r.envelope?.attachments?.invite_redeem&&!r.envelope?.attachments?.artifact).length)' "$ROOT/src/core/service.js" --input-type=module 2>/dev/null)
echo "notes Jordan's AI received from Anthony's: $J"; [ "${J:-0}" -ge 2 ] || { echo "FAIL: Anthony's AI's figures and review didn't both reach Jordan's AI"; ok=0; }
[ $ok = 1 ] && echo "PASS ($MODEL): the AIs built the one-pager together; nobody copied anything but the invite"
exit $((1 - ok))
