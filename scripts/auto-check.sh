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

# ── Detect project dir (works on both macOS and Linux) ───────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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
    # Cross-platform file size detection (macOS stat -f%z vs Linux stat -c%s)
    if stat -f%z "$LOG_FILE" 2>/dev/null; then
        LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null)   # macOS
    else
        LOG_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null)   # Linux
    fi
    LOG_SIZE=${LOG_SIZE:-0}
    LOG_SIZE_MB=$((LOG_SIZE / 1048576))
    if [ "$LOG_SIZE_MB" -gt "$MAX_LOG_SIZE_MB" ]; then
        # Keep last 20,000 lines (~2-3MB) as a tail, discard older entries
        tail -n 20000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 📜 Log rotated (was ${LOG_SIZE_MB}MB, exceeding ${MAX_LOG_SIZE_MB}MB limit)." >> "$LOG_FILE"
    fi
fi

# ── Environment ──────────────────────────────────────────────
cd "$PROJECT_DIR"
export HOME="${HOME:-/home/$USER}"
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"

# ── Run Claude in headless mode ──────────────────────────────
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🔍 Starting auto-check..." >> "$LOG_FILE"

claude -p "automatically check for replies and process them. If autoApproveDrafts is ON, send auto-replies immediately. If OFF, just record replies and classify intent." \
    --permission-mode auto \
    --output-format json \
    --max-budget-usd 2 \
    >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Auto-check complete." >> "$LOG_FILE"
