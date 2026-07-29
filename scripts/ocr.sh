#!/bin/bash
# OCR helper for auto_send_mail project
# Usage: bash scripts/ocr.sh <image-path>
# Reads token from references/mineru/config.yaml

CONFIG="e:/gitProject/auto_send_mail/references/mineru/config.yaml"
TOKEN=$(grep '^token:' "$CONFIG" | head -1 | cut -d' ' -f2)

if [ "$TOKEN" = "" ] || [ "$TOKEN" = "your-token-here" ]; then
  echo "❌ Token not configured!"
  echo "   Copy references/mineru/config.example.yaml → references/mineru/config.yaml"
  echo "   Then fill in your token from https://mineru.net/apiManage/token"
  exit 1
fi

export MINERU_TOKEN="$TOKEN"
cd e:/gitProject/auto_send_mail
npx mineru-open-api extract "$1" --model vlm --language ch 2>/dev/null
