#!/bin/bash
# Install / update the always-on autopilot as a launchd agent.
# launchd can't read the Files drive, so the runtime (app code + Jordan's agent data) lives in
#   ~/Library/Application Support/MeatProxyRemover/{app,data}
# Source of truth for code stays in this project; re-run this script after code changes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$HOME/Library/Application Support/MeatProxyRemover"
LABEL="local.meatproxyremover.autopilot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/MeatProxyRemover.log"
NODE="$(command -v node)"

mkdir -p "$SVC/app"

# 1. App code (runtime copy). node_modules come along; they're all production deps.
rsync -a --delete "$ROOT/src/" "$SVC/app/src/"
rsync -a --delete "$ROOT/node_modules/" "$SVC/app/node_modules/"
mkdir -p "$SVC/app/plugin" "$SVC/app/dist"
rsync -a --delete "$ROOT/plugin/skills/" "$SVC/app/plugin/skills/"
cp "$ROOT/package.json" "$SVC/app/"
[ -f "$ROOT/dist/release.json" ] && cp "$ROOT/dist/release.json" "$SVC/app/dist/"   # invites embed these download links

# 2. Agent data: move once from the project (keys, contacts, policy, history).
if [ ! -f "$SVC/data/identity.json" ]; then
  if [ -f "$ROOT/data/jordan/identity.json" ]; then
    mkdir -p "$SVC"
    cp -Rp "$ROOT/data/jordan" "$SVC/data"
    cmp -s "$ROOT/data/jordan/identity.json" "$SVC/data/identity.json"
    rm -rf "$ROOT/data/jordan"
    echo "moved agent data -> $SVC/data"
  else
    echo "no agent data found to move" >&2; exit 1
  fi
fi
chmod 700 "$SVC/data"; chmod 600 "$SVC/data/identity.json"

# 3. launchd agent
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$SVC/app/src/cli.js</string><string>autopilot</string><string>--interval</string><string>30</string></array>
  <key>WorkingDirectory</key><string>$SVC</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MPR_HOME</key><string>$SVC/data</string>
    <key>MPR_ROOT</key><string>$SVC</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout is asynchronous; wait for the old instance to disappear, then load (retrying the "I/O error 5" race).
for i in $(seq 1 20); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
for i in 1 2 3 4 5; do launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break; sleep 2; done
launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || { echo "autopilot failed to load" >&2; exit 1; }
echo "installed $LABEL  (log: $LOG)"
