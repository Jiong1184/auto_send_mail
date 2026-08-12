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
  ├── /card-followup (Skill)        ← Workflow orchestration (6 phases + Phase 0 IM detection)
  ├── MCP Servers (.mcp.json)       ← Backend capabilities
  │   ├── SQLite MCP (official)     → Database: contacts, emails, state, timeline, approvals
  │   ├── Email MCP (custom)        → SMTP send + IMAP receive
  │   └── Filesystem MCP (official) → Knowledge base document search
  ├── IM Bridge (cc-connect)        ← Feishu/WeCom push notifications + inbound card OCR
  │   ├── ~/.cc-connect/config.toml → Daemon config (platforms + agent adapter)
  │   └── cc-connect send CLI       → Fire push notifications to all active IM platforms
  ├── Agents (.claude/agents/)
  │   ├── auto-reply-checker        → Cron-based IMAP poll + auto-reply
  │   └── im-inbound-processor      → IM image OCR → card → draft → approval flow
  ├── CLAUDE.md                     ← This file (project context)
  └── settings.json                 ← Permissions + hooks
```

## Database

All data stored in `data/crm.db` (SQLite). Tables:
- `contacts` — email (UNIQUE dedup key), name, company, title, phone, notes
- `email_log` — outbound/inbound emails with Message-ID threading
- `workflow_state` — per-contact state machine persistence
- `timeline` — append-only audit log of all events
- `pending_approvals` — IM draft approval tracking (platform, status, expires_at, 30-min timeout)

## Workflow State Machine

```
                    ┌── (outreach sent) ──→ EMAIL_SENT ──→ (reply) ──→ INTERESTED → HANDED_OVER
                    │                                                    │             │
COLD INBOUND ──→ NEW                                                    │             │
(cold_inbound)    │                                                    │             │
                    │                                                    ▼             ▼
                    └── (reply received directly) ─────────────────→ NOT_INTERESTED (exit)    (post-handoff replies
                                                                                              → recorded only, no auto-processing)
```

- **NEW**: Contact created, no email sent yet. Entry paths: (1) card input via Phase 2, (2) cold inbound via Phase 4 Tier 3
- **EMAIL_SENT**: Outreach email sent, awaiting reply
- **INTERESTED**: Prospect replied with interest → AI composes auto-reply
- **NOT_INTERESTED**: Prospect declined or not interested → exit
- **HANDED_OVER**: Auto-reply sent, ready for human follow-up on shipping/delivery. **Post-handoff rule:** Further replies from the prospect or follow-up person are recorded (email_log + timeline, event_type='reply_recorded') but NOT auto-processed — no intent classification, no auto-reply. The human is handling this conversation manually.
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

**After HANDED_OVER:** When a contact is in HANDED_OVER state, any further replies (from the prospect or the follow-up person) are still matched via the three-tier system and recorded to email_log + timeline (with event_type='reply_recorded'), but **no further processing occurs** — skip intent classification (Phase 5) and auto-reply (Phase 6). The human follow-up person is handling the conversation manually outside the CRM.

## Key Design Decisions

- **Human-in-the-loop**: All outbound emails must be reviewed and approved before sending
- **Deduplication**: Email address is the unique key; cannot send to the same address twice
- **IMAP polling**: Reply checking is manual (user runs `/card-followup` → "Check replies"); optional auto-polling via cron
- **Three-tier reply matching**: Thread-based (Message-ID) → Contact-based (sender email) → Cold inbound (auto-create new lead)
- **All operations logged**: Every state change and email is recorded in `timeline` table
- **All operations logged**: Every state change and email is recorded in `timeline` table
- **Plaintext KB**: Knowledge base is Markdown files (not a vector DB) — sufficient for <10 docs

## Pricing Disclosure Policy (价格披露政策)

- **可以发送给客户:** 产品目录册 `优旦防护箱产品手册(手机版).pdf`。
- **禁止发送给客户:** 全量价格表 `压塑箱价格.xls` 或完整价格表。价格表仅供内部参考。
- **按需报价:** 仅当客户明确询问某一款具体产品型号时，才回复该款产品的单独价格。
- 邮件正文/自动回复中不要罗列全系列价格，应引导客户告知所需具体型号。
- Source of truth: `references/knowledge-base/pricing.md`（顶部含内部使用警告）与 `references/knowledge-base/product-intro.md` → "Pricing Disclosure Policy"。

### Pricing Calculation (报价换算规则)

When a customer requests a quote, use these conversion rules (given by the user, confirmed 2026-08-12):

- **美金价 (USD unit price) = 人民币出厂价 (RMB ex-factory price) ÷ 6.2**
- **FOB 美金价 (FOB USD price) = (货代费用 ÷ 6.2) ÷ 订购数量 (order quantity) + 人民币出厂价 ÷ 6.2**

**Freight cost tier** — based on total order volume (freight costs are in **RMB**; ÷ 6.2 to convert to USD before apportioning):
1. Compute each model's per-unit volume from its **outer dimensions** 长×宽×高 (mm → m), then × quantity; sum all models for the total m³.
2. Total ≤ 28 m³ → 20ft container (28 m³), freight cost = **¥2500** (÷6.2 → USD).
3. 28 m³ < total ≤ 68 m³ → 40ft high-cube container (68 m³), freight cost = **¥3500** (÷6.2 → USD).

**人民币报价 (RMB quote)** — when the customer asks for RMB pricing:
1. First ask the customer for their **shipping destination / delivery address** (发货地址).
2. Calculate the logistics cost for that destination using the **logistics company price list** (物流公司报价清单 — to be provided by the user).
3. **人民币总价 (RMB total) = 产品出厂价 (product ex-factory price) + 物流费 (logistics cost).**

Apply these ONLY when the customer explicitly asks for USD / FOB USD / RMB pricing.

## Email Signature (标准落款)

Every outbound email and auto-reply MUST be signed with the following block verbatim:

```
Best regards,
YOUDAN TRADING CO.,LIMITED
sales6@zonade.cn
www.zonade.cn
```

- The company line is **YOUDAN TRADING CO.,LIMITED** — do NOT sign as "ZONADE Sales Team".
- An individual sales rep's name may be added above the company line only when a specific rep is assigned.
- Source of truth: `references/knowledge-base/product-intro.md` → "Standard Email Signature" and the templates in `references/templates/`.

## IM Integration (cc-connect)

This project uses [cc-connect](https://github.com/chenhg5/cc-connect) to bridge Feishu (飞书) and WeCom (企业微信). The daemon runs as a separate process (`cc-connect serve`) and connects via WebSocket — **no public IP required**.

### IM Platforms

| Platform | Config | Setup Guide |
|----------|--------|-------------|
| 飞书 (Feishu) | `~/.cc-connect/config.toml` → `[[projects.platforms]] type="feishu"` | `references/feishu-setup.md` |
| 企业微信 (WeCom) | `~/.cc-connect/config.toml` → `[[projects.platforms]] type="wecom"` | `references/wecom-setup.md` |

### IM Notification Settings

Controlled by `references/crm-settings.json` → `im`:
- `im.enabled` — master kill switch
- `im.platforms` — active platforms (e.g. `["wecom", "feishu"]`)
- `im.notifications.{key}` — per-event toggles (newReply, interestedIntent, coldInbound, autoReplySent, systemError, emailSent, notInterested)
- `im.inbound.enabled` — whether IM card image OCR processing is active
- `im.inbound.approvalTimeoutMinutes` — draft expiry (default 30 min)

### Outbound Push Notifications

At key workflow points (Phase 3-6), the skill fires push notifications via:
```bash
cc-connect send --project crm -m "message text"
```
Push notifications are **fire-and-forget** and go to ALL active platforms. Each event is gated by its `im.notifications.{key}` toggle.

### IM Inbound Card Processing (Phase 0)

When a user sends a business card image via Feishu/WeCom:

1. cc-connect downloads the image and appends `[Image saved at: /tmp/xxx.png]` to the prompt
2. If the prompt contains `[Image saved at:`, **do NOT show the interactive menu** — go to IM inbound flow
3. Follow the workflow defined in `.claude/agents/im-inbound-processor.md`:
   - Read image → OCR via `scripts/ocr.sh` → extract contact info → dedup
   - Generate outreach draft → store in `email_log` (status=draft) + `pending_approvals`
   - Push draft back to IM for approval: 「回复「批准」发送，回复「拒绝」取消」
4. When user replies with approval/rejection text, check `pending_approvals` and act
5. Supports multi-draft: 「批准1」「拒绝2」「批准{name}」「全部批准」
6. If `autoApproveDrafts` is ON, **still require IM approval** — OCR accuracy is lower than manual input
7. **Output control**: cc-connect auto-delivers ALL output to IM users. The IM agent
   MUST NOT expose thinking process, tool calls, file paths, or parameters. Use only
   `cc-connect send -m "..."` for user-facing messages, followed by `NO_REPLY`.
   Keep messages to 2-4 lines max (except draft emails needing full content).

### Bounce / OOO Detection

When checking replies (Phase 4 / auto-reply-checker), classify these as **NOT_INTERESTED** and do NOT auto-reply:

| Pattern | Reason |
|---------|--------|
| `Auto-Submitted: auto-replied` header | OOO / vacation auto-responder |
| `Auto-Submitted: auto-generated` header | Automated system reply |
| Subject contains "Undelivered Mail" / "Returned Mail" / "Mail Delivery" | Bounce / NDR |
| Subject contains "退信" / "系统退信" | Bounce (Chinese) |
| Body contains "delivery failure" / "could not be delivered" | SMTP bounce |
| Body contains "out of office" / "休假" / "自动回复" | OOO message |

These are system-generated — never auto-reply to them, even if the text looks "interested".

### Expired Approval Cleanup

`pending_approvals` records with `expires_at < datetime('now')` are stale. Cleanup runs:
- On every IM approval reply (Branch B1.5): expired records are marked before processing
- On Phase 1 (main menu) and Phase 4 (reply check): query and expire stale records
- Expired drafts remain in `email_log` (status=draft) and can be manually sent later
