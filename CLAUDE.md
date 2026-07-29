# AI Email Outreach Mini-CRM

A Claude Code-native mini-CRM for managing email outreach campaigns. Runs entirely within Claude Code using MCP servers for backend capabilities and a Skill for workflow orchestration.

## Prerequisites

1. **Node.js** installed (for the custom Email MCP server)
2. **QQ Mail** with SMTP/IMAP enabled:
   - Login to QQ Mail → Settings → Account → Enable "POP3/SMTP Service" and "IMAP/SMTP Service"
   - Get the authorization code (NOT your QQ password)
3. Configure credentials: copy `scripts/email-mcp-server/config.example.json` to `config.json` and fill in your QQ Mail credentials

## Quick Start

1. Install MCP dependencies:
   ```
   cd scripts/email-mcp-server && npm install
   ```
2. Set up your QQ Mail credentials in `scripts/email-mcp-server/config.json`
3. Set up MinerU for OCR:
   - Copy `references/mineru/config.example.yaml` → `references/mineru/config.yaml`
   - Fill in your API token from https://mineru.net/apiManage/token
   - Usage: `npm run ocr <image-path>` or `npx mineru-open-api extract <file> --model vlm`
4. Initialize the database: run `/card-followup` and select "Setup database" on first run
5. Add your product/company info to the KB documents in `references/knowledge-base/`

## How to Use

- **Send outreach email**: `/card-followup` → "Input new business card"
- **Check for replies**: `/card-followup` → "Check for new replies"
- **View prospect status**: `/card-followup` → "View contact status"
- **Re-classify a prospect**: `/card-followup` → "Manually re-classify"

## Architecture

```
Claude Code Client
  ├── /card-followup (Skill)        ← Workflow orchestration (6 phases)
  ├── MCP Servers (.mcp.json)       ← Backend capabilities
  │   ├── SQLite MCP (official)     → Database: contacts, emails, state, timeline
  │   ├── Email MCP (custom)        → SMTP send + IMAP receive
  │   └── Filesystem MCP (official) → Knowledge base document search
  ├── CLAUDE.md                     ← This file (project context)
  └── settings.json                 ← Permissions + hooks
```

## Database

All data stored in `data/crm.db` (SQLite). Tables:
- `contacts` — email (UNIQUE dedup key), name, company, title, phone, notes
- `email_log` — outbound/inbound emails with Message-ID threading
- `workflow_state` — per-contact state machine persistence
- `timeline` — append-only audit log of all events

## Workflow State Machine

```
                    ┌── (outreach sent) ──→ EMAIL_SENT ──→ (reply) ──→ INTERESTED → HANDED_OVER
                    │                                                    │
COLD INBOUND ──→ NEW                                                    │
(cold_inbound)    │                                                    │
                    │                                                    ▼
                    └── (reply received directly) ─────────────────→ NOT_INTERESTED (exit)
```

- **NEW**: Contact created, no email sent yet. Entry paths: (1) card input via Phase 2, (2) cold inbound via Phase 4 Tier 3
- **EMAIL_SENT**: Outreach email sent, awaiting reply
- **INTERESTED**: Prospect replied with interest → AI composes auto-reply
- **NOT_INTERESTED**: Prospect declined or not interested → exit
- **HANDED_OVER**: Auto-reply sent, ready for human follow-up on shipping/delivery
- **EXITED**: Manually exited from pipeline
- **ERROR**: Something went wrong (SMTP failure, etc.)

### Reply Matching Strategy (Three-Tier)

When checking replies (Phase 4), each incoming message goes through three tiers before being skipped:

| Tier | Method | Match Key | Result |
|------|--------|-----------|--------|
| 1 | Thread-based | `In-Reply-To` / `References` → `email_log.message_id` | Existing contact, normal reply flow |
| 2 | Contact-based | Sender email → `contacts.email` | Existing contact, broken Message-ID chain |
| 3 | Cold inbound | None — new prospect | Auto-create contact, classify intent, auto-reply |

System notifications (Alibaba Cloud, Tencent/QQ, bounce/undelivered, 欠费/额度不足) are filtered before matching.

## Key Design Decisions

- **Human-in-the-loop**: All outbound emails must be reviewed and approved before sending
- **Deduplication**: Email address is the unique key; cannot send to the same address twice
- **IMAP polling**: Reply checking is manual (user runs `/card-followup` → "Check replies"); optional auto-polling via cron
- **Three-tier reply matching**: Thread-based (Message-ID) → Contact-based (sender email) → Cold inbound (auto-create new lead)
- **All operations logged**: Every state change and email is recorded in `timeline` table
- **All operations logged**: Every state change and email is recorded in `timeline` table
- **Plaintext KB**: Knowledge base is Markdown files (not a vector DB) — sufficient for <10 docs
