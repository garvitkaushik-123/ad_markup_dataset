#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.crackle.ad-scraper"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
CONFIG="$DIR/scrape_sites.json"
NODE="$(which node)"

HOURS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).interval_hours||6)")
SECONDS_INTERVAL=$((HOURS * 3600))

mkdir -p "$DIR/logs"

# unload existing job if present
launchctl list | grep -q "$PLIST_NAME" && launchctl unload "$PLIST_DEST" 2>/dev/null || true

cat > "$PLIST_DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE}</string>
        <string>scrape.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DIR}</string>
    <key>StartInterval</key>
    <integer>${SECONDS_INTERVAL}</integer>
    <key>StandardOutPath</key>
    <string>${DIR}/logs/scraper.log</string>
    <key>StandardErrorPath</key>
    <string>${DIR}/logs/scraper-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

launchctl load "$PLIST_DEST"
echo "Installed: runs every ${HOURS}h (${SECONDS_INTERVAL}s). Plist at ${PLIST_DEST}"
