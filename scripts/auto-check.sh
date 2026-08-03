#!/bin/bash
# Auto-Check Script — runs Claude Code in headless mode to check for email replies.
# Designed to be invoked by system cron every N minutes.
#
# Setup:
#   1. Make executable: chmod +x scripts/auto-check.sh
#   2. Run: claude setup-token  (one-time, requires Claude subscription)
#   3. Enable via /card-followup main menu → "Enable auto-polling"
#
# Cron entry (managed by the Skill):
#   */5 * * * * /path/to/auto_send_mail/scripts/auto-check.sh

set -euo pipefail

PROJECT_DIR="/Users/fqh1184/projects/gitProjects/auto_send_mail"
LOG_FILE="$PROJECT_DIR/data/auto-check.log"
LOCK_FILE="/tmp/auto-check-crm.lock"

# ── Mutex: prevent overlapping runs ──────────────────────────
exec 200>"$LOCK_FILE"
flock -n 200 || {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⏭ Previous check still running, skipping." | tee -a "$LOG_FILE"
    exit 0
}

# ── Log rotation: keep max 50MB ──────────────────────────────
MAX_LOG_SIZE_MB=50
if [ -f "$LOG_FILE" ]; then
    LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
    LOG_SIZE_MB=$((LOG_SIZE / 1048576))
    if [ "$LOG_SIZE_MB" -gt "$MAX_LOG_SIZE_MB" ]; then
        # Keep last 20,000 lines (~2-3MB) as a tail, discard older entries
        tail -n 20000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 📜 Log rotated (was ${LOG_SIZE_MB}MB, exceeding ${MAX_LOG_SIZE_MB}MB limit)." >> "$LOG_FILE"
    fi
fi

# ── Environment ──────────────────────────────────────────────
cd "$PROJECT_DIR"
export HOME=/Users/fqh1184
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# ── Run Claude in headless mode ──────────────────────────────
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🔍 Starting auto-check..." >> "$LOG_FILE"

claude -p "automatically check for replies and process them. If autoApproveDrafts is ON, send auto-replies immediately. If OFF, just record replies and classify intent." \
    --permission-mode auto \
    --output-format json \
    --max-budget-usd 2 \
    >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Auto-check complete." >> "$LOG_FILE"
