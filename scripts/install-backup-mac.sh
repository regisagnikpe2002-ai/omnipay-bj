#!/bin/bash
# Programme la sauvegarde OMNIPAY tous les jours à 02:00 sur ce Mac (et au démarrage si elle a été manquée). Usage : bash scripts/install-backup-mac.sh
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"; NODE="$(command -v node)"
[ -z "$NODE" ] && { echo "node introuvable"; exit 1; }
PL="$HOME/Library/LaunchAgents/com.omnipay.backup.plist"; mkdir -p "$HOME/Library/LaunchAgents" "$HOME/OMNIPAY-SAUVEGARDES"
cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.omnipay.backup</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/scripts/backup-local.js</string></array>
<key>WorkingDirectory</key><string>$DIR</string>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>$HOME/OMNIPAY-SAUVEGARDES/journal.log</string>
<key>StandardErrorPath</key><string>$HOME/OMNIPAY-SAUVEGARDES/journal.log</string>
</dict></plist>
EOF
launchctl unload "$PL" 2>/dev/null || true; launchctl load "$PL"
echo "OK : sauvegarde quotidienne programmée (02:00). Dossier : ~/OMNIPAY-SAUVEGARDES. Journal : journal.log"
