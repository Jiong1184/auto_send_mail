#!/bin/bash
# Install / remove the CRM IMAP IDLE auto-reply daemon as a systemd service.
# Replaces the old crontab-based auto-polling on Linux.
#
# Usage:
#   sudo bash scripts/install-idle-daemon.sh            # install + enable + start
#   sudo bash scripts/install-idle-daemon.sh --remove   # stop + disable + remove
#
# The daemon runs as the invoking (non-root) user, who must already have:
#   - IMAP credentials in scripts/email-mcp-server/config.json
#   - Claude Code CLI authenticated (claude setup-token)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_NAME="crm-idle-daemon"
UNIT_SRC="$PROJECT_DIR/deploy/crm-idle-daemon.service"
UNIT_DST="/etc/systemd/system/${UNIT_NAME}.service"

if [ "${1:-}" = "--remove" ]; then
    echo "▶ Removing ${UNIT_NAME} service..."
    systemctl disable --now "${UNIT_NAME}" 2>/dev/null || true
    rm -f "$UNIT_DST"
    systemctl daemon-reload
    echo "✅ ${UNIT_NAME} removed. (scripts/auto-check.sh is still available for manual 'check now'.)"
    exit 0
fi

# ── Resolve runtime paths ──────────────────────────────────
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "❌ 'node' not found on PATH — cannot install. Install Node.js first."
    exit 1
fi

# When run via sudo, run as the real (non-root) user so Claude's CLI auth & home are used.
RUN_USER="${SUDO_USER:-$(id -un)}"
if [ "$RUN_USER" = "root" ]; then
    echo "⚠️  Running as root. The daemon will run as root — ensure IMAP config and claude CLI auth are available."
fi
RUN_USER_HOME="$(eval echo "~${RUN_USER}")"

echo "▶ Installing ${UNIT_NAME} (user=${RUN_USER}, node=${NODE_BIN}, project=${PROJECT_DIR})"
sed -e "s|@PROJECT_DIR@|$PROJECT_DIR|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@RUN_USER@|$RUN_USER|g" \
    -e "s|@RUN_USER_HOME@|$RUN_USER_HOME|g" \
    "$UNIT_SRC" > "$UNIT_DST"

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
echo "✅ ${UNIT_NAME} enabled and started."
systemctl --no-pager status "$UNIT_NAME" || true
echo
echo "▶ Logs: tail -f ${PROJECT_DIR}/data/idle-daemon.log"
echo "▶ Stop:  systemctl stop ${UNIT_NAME} | Disable: sudo bash $0 --remove"
