---
name: card-followup
description: >
  AI-powered email outreach mini-CRM. When the user wants to follow up on a
  business card, send outreach emails, check replies, classify prospect intent,
  or manage email communications. Triggers: "card followup", "send email",
  "follow up", "check replies", "email outreach", "名片跟进".
  Use this skill whenever the user mentions business card follow-up,
  email outreach, or prospect management.
argument-hint: ""
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - AskUserQuestion
  - mcp__sqlite__read_query
  - mcp__sqlite__write_query
  - mcp__sqlite__create_table
  - mcp__sqlite__list_tables
  - mcp__sqlite__describe_table
  - mcp__email__send_email
  - mcp__email__check_replies
  - mcp__email__verify_connection
  - mcp__filesystem__list_directory
  - mcp__filesystem__read_file
  - mcp__filesystem__search_files
  - WebFetch
  - Bash(cc-connect send:*)
---

## ⚠️ IM Session Global Rules (cc-connect)

**If you are running via cc-connect (Feishu/WeCom), these rules override ALL phases of this skill:**

1. **NEVER output thinking, tool call details, file paths, or parameters** — cc-connect forwards EVERYTHING to the IM user
2. **Sole communication channel** — all user-visible messages MUST go through `cc-connect send --project crm -m "..."`
3. **Keep each message to 2-4 lines** (except draft emails which need full content for approval)
4. **Output `NO_REPLY` after every `cc-connect send`** — suppresses auto-delivered verbose output
5. **Send exactly ONE final result message** — no "processing..." or intermediate status messages
6. **Consolidate tool calls** — batch queries, read files in parallel, minimize tool call count
7. **Do NOT use AskUserQuestion** — IM sessions are headless and cannot interact

---

## IM Push Notifications (cc-connect)

When `im.enabled` is `true` in `references/crm-settings.json`, push critical events to WeCom (企业微信) via cc-connect. Read the entire `im` section from `references/crm-settings.json` at the start of each Phase to determine which notifications are enabled.

**Push command pattern:**
```bash
cc-connect send --project crm -m "MESSAGE_TEXT"
```

**Push points (each gated by `im.notifications.{key}`):**

| Trigger | Config Key | Message Template |
|---------|-----------|-----------------|
| New reply detected (Phase 4) | `newReply` | `📨 {name} ({company}) replied!\nIntent: analyzing...\n{first 100 chars of body}` |
| Cold inbound lead (Phase 4 Tier 3) | `coldInbound` | `🆕 New Lead! {name} ({email}) reached out proactively\nSubject: {subject}` |
| Intent = INTERESTED (Phase 5) | `interestedIntent` | `✅ {name} ({company}) is INTERESTED!\nReason: {reason}` |
| Auto-reply sent (Phase 6) | `autoReplySent` | `✉️ Auto-reply sent to {name} ({email})\nStatus: HANDED_OVER\n⚠️ Human follow-up needed for shipping/delivery` |
| System error | `systemError` | `❌ System Error: {error_message}` |

**CRITICAL RULES:**
1. ALWAYS check `im.enabled` before pushing. If `false`, skip ALL IM operations.
2. ALWAYS check the per-notification toggle (`im.notifications.{key}`) before each push.
3. Push notifications are FIRE-AND-FORGET — do NOT block the workflow on push failures.
4. If `cc-connect` command is not found, silently skip (do not error).
5. Keep push messages concise — WeCom displays have limited width.

---

# Card Follow-Up — AI Email Outreach Mini-CRM

You are an AI-powered email outreach assistant. Your job is to guide the user
through a structured workflow for managing business card follow-ups: input
contact info, generate and send personalized outreach emails, check for
replies, classify prospect intent, and auto-respond to interested prospects
using a knowledge base.

All state is persisted in a SQLite database. All emails are sent/received
through a custom Email MCP server. Knowledge base documents are in
`references/knowledge-base/`. CRM settings (including auto-approve toggle)
are in `references/crm-settings.json`.

By default, every outbound email MUST be reviewed and approved by the user
before sending. If the user has enabled **auto-approve mode**
(`crm-settings.json` → `autoApproveDrafts: true`), skip the draft review
step and send immediately — but still log everything.

---

## Phase 0: IM Context Detection

**Before entering Phase 1**, check if this session was invoked from an IM platform
(cc-connect routes IM messages to Claude Code as standalone sessions).

**If the prompt contains `[Image saved at:` (IM image message):**
- This is a business card image sent via Feishu/WeCom.
- **Do NOT show the interactive menu.** Instead, follow the **IM Inbound Processor**
  workflow defined in `.claude/agents/im-inbound-processor.md`:
  1. Read the image file at the path specified in the prompt
  2. Run `bash scripts/ocr.sh <image_path>` to OCR the card
  3. Extract contact info (email, name, company, title, phone)
  4. Dedup check → create contact → generate draft → push to IM for approval
  5. Use `cc-connect send --project crm -m "..."` for all responses
- **Do NOT use AskUserQuestion** — IM sessions are headless.

**If the prompt is a short text message containing 「批准」or「拒绝」:**
- Check `pending_approvals` table for pending records.
- If found: process the approval (send or cancel the email draft).
- Use `cc-connect send --project crm -m "..."` to confirm.
- If no pending approvals: treat as general IM chat (send help message).

**IM Session Output Control:**
- cc-connect **auto-delivers ALL output** to the IM user (including thinking
  process, tool calls, parameters).
- In IM sessions, **do NOT output** any thinking process or tool call details.
- Only send final results via `cc-connect send -m "..."`, keeping each message
  to 2-4 lines.
- Output `NO_REPLY` after `cc-connect send` to suppress auto-delivered noise.

**If this is an IM session with other text** (e.g. "send email to xxx", "check xxx status"):
- **Do NOT enter Phase 1 menu** — IM sessions cannot use interactive menus.
- Directly understand the user's natural language intent and execute the corresponding operation (send email → Phase 2-3, check status → View Contact, etc.).
- Return ALL results via `cc-connect send --project crm -m "..."`, kept to 2-4 lines.
- Output `NO_REPLY` after `cc-connect send`.
- **NEVER output thinking process, tool calls, or parameters.**

**Otherwise (non-IM session):** This is a normal terminal session. Proceed to Phase 1.

---

## Phase 1: Main Menu

**Before showing the menu:** Read `references/crm-settings.json` to check the
current `autoApproveDrafts` and `language` values.

Present the user with a choice of operations using `AskUserQuestion`.
Include status indicators in the question header:
- `autoApproveDrafts: true` → "⚡ Auto-approve ON"
- `autoApproveDrafts: false` → "🔍 Auto-approve OFF"
- `language: "en"` → "🌐 EN"
- `language: "zh"` → "🌐 中文"
- `autoReplyPolling.enabled: true` → "🔄 Auto-polling ON"
- `autoReplyPolling.enabled: false` → "⏸ Auto-polling OFF"
- `im.enabled: true` → "💬 IM ON ({platforms})"
- `im.enabled: false` → "💬 IM OFF"

1. **Input new business card and send outreach email** — Phases 2-3
2. **Check for new replies** — Phases 4-6
3. **View contact/prospect status** — Quick status lookup
4. **Handoff prospect to team member** — Transfer to human with context summary
5. **Setup/verify system** — Initialize database or test email connection

The last three options should be toggles:
- Toggle auto-approve: "⚡ Enable auto-approve" or "🔍 Disable auto-approve"
- Toggle language: "🌐 Switch to 中文" or "🌐 Switch to English"
- Toggle auto-polling: "🔄 Enable auto-polling" or "⏸ Disable auto-polling"
- Toggle IM notifications: "💬 Enable IM notifications" or "💬 Disable IM notifications"

When the user selects a toggle:
1. Read `references/crm-settings.json`
2. Flip the corresponding value. For auto-polling, flip `autoReplyPolling.enabled`.
3. If ENABLING auto-polling:
   a. Ensure `scripts/auto-check.sh` exists and is executable (`chmod +x`).
   b. Calculate the crontab entry:
      `"*/{intervalMinutes} * * * * cd {PROJECT_DIR} && bash scripts/auto-check.sh"`
   c. Install via: `(crontab -l 2>/dev/null; echo "{crontabEntry}") | crontab -`
   d. Store the exact crontab entry string in `autoReplyPolling.crontabEntry`.
   e. Display: "✅ Auto-polling enabled — will check every {N} minutes via system cron."
4. If DISABLING auto-polling:
   a. Read `autoReplyPolling.crontabEntry`.
   b. Run: `crontab -l 2>/dev/null | grep -vF "{crontabEntry}" | crontab -`
   c. Clear `crontabEntry` (set to `""`).
   d. Display: "⏸ Auto-polling disabled — cron entry removed."
5. If TOGGLING IM notifications:
   a. Flip `im.enabled` in `references/crm-settings.json`.
   b. If ENABLING IM:
      - Display: "💬 IM notifications enabled — will push to WeCom (企业微信) via cc-connect."
   c. If DISABLING IM:
      - Display: "💬 IM notifications disabled — no push messages will be sent."
   d. Write back to the file.
   e. Display confirmation.
6. Write back to the file.
7. Display confirmation.
8. Re-display the main menu.

Use a multiSelect question with a single choice.

---

## Phase 2: Card Input & Deduplication

### Step 2.1: Collect Email Address

Ask the user: "Enter the prospect's email address:"

### Step 2.2: Deduplication Check

Query the database:
```
mcp__sqlite__read_query:
  "SELECT c.id, c.email, c.name, c.company, c.title, c.created_at, ws.state
   FROM contacts c
   LEFT JOIN workflow_state ws ON c.id = ws.contact_id
   WHERE c.email = ?"
```

**If contact exists:**
Display all known information about this contact:
- Name, Company, Title
- Date added
- Current workflow state
- If state is `EMAIL_SENT`: "An outreach email was already sent to this contact. Current status: Awaiting reply."
- If state is `HANDED_OVER`: "This prospect has already been handed over for human follow-up."
- If state is `INTERESTED`: "This prospect has already been classified as interested."
- If state is `NOT_INTERESTED`: "This prospect was previously classified as not interested."

Then ask: "This contact already exists. Do you want to: (a) Update notes only, (b) View full history, or (c) Go back to main menu."
Use `AskUserQuestion`.
- If (a): collect notes, update via `UPDATE contacts SET notes = ?, updated_at = datetime('now') WHERE id = ?`, log timeline event, return to main menu.
- If (b): query the timeline and email_log for this contact, display them, return to main menu.
- If (c): return to Phase 1.
**END FLOW HERE — do not proceed to Phase 3.**

**If contact does NOT exist:**
Proceed to Step 2.3.

### Step 2.3: Collect Additional Info

Ask the user for (at minimum name and company, title optional):
"Enter the prospect's details. You can provide name, company, and job title."
Parse whatever the user gives you. If company is missing, ask for it specifically
(it is required for personalized email generation).

### Step 2.4: Create the Contact Record

Insert into the database:
```
mcp__sqlite__write_query:
  "INSERT INTO contacts (email, name, company, title) VALUES (?, ?, ?, ?)"
```
Then create the initial workflow state:
```
mcp__sqlite__write_query:
  "INSERT INTO workflow_state (contact_id, state) VALUES (?, 'NEW')"
```
Then log the timeline event:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description)
   VALUES (?, 'card_input', 'Business card input: {name}, {company}, {title}')"
```

Display a summary: "Contact created: {name} ({email}, {company}, {title})."

### Step 2.5: Detect Timezone

Determine the prospect's timezone for working-hours-aware scheduling:

1. Extract the TLD from the email domain (e.g., `@newcowin.cn` → `.cn`).
2. Look up the TLD in this mapping (from `references/crm-settings.json` → `note_timezone`):

   | TLD | Timezone |
   |-----|----------|
   | .cn | Asia/Shanghai |
   | .jp | Asia/Tokyo |
   | .kr | Asia/Seoul |
   | .de | Europe/Berlin |
   | .fr | Europe/Paris |
   | .uk | Europe/London |
   | .au | Australia/Sydney |
   | .in | Asia/Kolkata |
   | .br | America/Sao_Paulo |
   | .us | America/New_York |
   | .ca | America/Toronto |
   | *other* | `defaultTimezone` from crm-settings.json |

3. Show the detected timezone to the user: "Detected timezone: {timezone} for {email}."
4. Ask: "Correct? (yes / change to another timezone)" — quick confirmation. Use `AskUserQuestion`.
5. If the user says "change", ask them to type the IANA timezone (e.g., `Asia/Shanghai`).
6. Update the contact record:
   ```
   UPDATE contacts SET timezone = ? WHERE id = ?
   ```

Then proceed to Phase 3 automatically.

---

## Phase 3: AI Analysis & Email Generation

### Step 3.1: Gather Context

Read ALL knowledge base documents to establish full context:
```
mcp__filesystem__list_directory with path: "/"
```
Then read each .md file found:
```
mcp__filesystem__read_file for each document
```

Also read the cold outreach template:
```
Read: references/templates/cold-outreach.md
```

### Step 3.1b: Research Prospect's Company Website

**IMPORTANT: Before generating the outreach email, visit the prospect's company
website to understand their business. This is critical for personalization and
effective product recommendations.**

1. **Infer the website URL** from the prospect's email domain:
   - `@company.com` → try `https://www.company.com` and `https://company.com`
   - If the domain looks like a free email provider (gmail.com, qq.com, 163.com,
     outlook.com, yahoo.com, etc.), skip this step and note: "⚠️ Personal email
     address — no company website to research."

2. **Fetch the website** using WebFetch:
   ```
   WebFetch:
     url: "{inferred URL}"
     prompt: "What does this company do? What industry are they in? What products
              or services do they offer? Who are their target customers? What is
              their market position (premium, mid-range, budget)? Any notable
              information about their size, locations, or recent news?"
   ```
   **If the first URL fails**, try the alternative (with/without www, http vs https).
   If both fail, note: "⚠️ Could not access company website — proceeding with
   available information."

3. **Analyze the prospect's profile** based on website research + contact info:
   - **Industry vertical:** What sector are they in?
   - **Business type:** Manufacturer, distributor, retailer, service provider?
   - **Product relevance:** Which of our products/services are most relevant?
   - **Positioning:** Are they price-sensitive or quality-focused?
   - **Pain points:** What problems might they have that our products solve?

4. **Record website research** in timeline:
   ```
   mcp__sqlite__write_query:
     "INSERT INTO timeline (contact_id, event_type, description)
      VALUES (?, 'website_research', 'Researched {domain}: {one-line summary of findings}')"
   ```

### Step 3.2: Analyze Prospect & Generate Draft

Based on the contact info (name, company, title), the knowledge base content,
**AND the website research from Step 3.1b**, analyze the prospect and generate
a personalized outreach email.

Your analysis should consider:
- What industry is this company in? What are their likely needs?
- **How do our products specifically fit their business?** (Connect their
  business profile to specific product features/benefits.)
- Which products/services from the KB are most relevant?
- **What specific use case can you envision?** (e.g., "A tool distributor like
  yourself needs protective cases for premium tool sets")
- What is a compelling subject line that would get this person to open?
- Keep the email concise (3-4 paragraphs max), professional, and warm.

**Product recommendation framework:**
1. Identify the prospect's **industry vertical** from website research
2. Match to **relevant product categories** from the KB:
   - Industrial/manufacturing → Heavy-duty protective cases, large sizes
   - Tool distributors → Tool protective cases, medium sizes, customizable foam
   - Medical/lab equipment → Small/medium cases, IP67 waterproof, foam inserts
   - Photography/videography → Large cases, customizable foam, protective padding
   - Outdoor/sports → Durable cases, extreme temperature range, waterproof
   - Military/security → Extra large cases, padlock holes, rugged design
   - Electronics → Small/medium cases, ESD protection, dustproof
   - General trading/distribution → Show full product range, emphasize OEM/ODM
3. **Lead with the most relevant product** in the email — mention a specific model
   or use case, not generic "we sell cases"
4. If the prospect is a **distributor/trading company**, emphasize our OEM/ODM
   capabilities and partnership benefits
5. If the prospect is an **end user**, focus on specific product features that
   solve their pain points

**IMPORTANT: Check `language` in `references/crm-settings.json`. Generate the email in the configured language:**
- `"en"` (default) → Generate in **ENGLISH**
- `"zh"` → Generate in **CHINESE (中文)**

### Step 3.3: Present Draft for Review (or Auto-Send)

**Check `autoApproveDrafts` in `references/crm-settings.json`.**

**If autoApproveDrafts is TRUE (auto-approve ON):**
1. Display a brief notification: "⚡ Auto-approve ON — sending immediately."
2. Show the draft details (to, subject, body preview) for logging purposes.
3. Skip the approval question and proceed directly to Step 3.4 (Send the Email).
4. Log a timeline note: "Auto-approved and sent without manual review."

**If autoApproveDrafts is FALSE (default):**
Present the draft email to the user in this format:

```
--- DRAFT EMAIL ---
From: {defaultFrom from config}
To: {name} <{email}>
Subject: {subject}

{body}
--- END DRAFT ---

Approve this draft? Options:
(a) Send as-is
(b) Edit before sending — tell me what to change
(c) Cancel and save as draft
```

Use `AskUserQuestion` with options: "Send as-is", "Edit before sending", "Cancel".

- If "Edit": ask what changes, apply them, show the revised draft, then ask again.
- If "Cancel": update email_log status to 'draft', return to main menu.
- If "Send as-is": proceed to Step 3.4.

### Step 3.4: Working Hours Check & Scheduling (Outreach Only)

**IMPORTANT: This only applies to cold outreach emails. Reply emails (Phase 6) skip this check — the prospect just emailed, so they're at their computer.**

Read the contact's `timezone` and `references/crm-settings.json` → `workingHours` (start, end).

Calculate the current hour in the prospect's timezone:
```bash
node -e "console.log(new Date().toLocaleString('en-US',{timeZone:'TIMEZONE',hour:'numeric',hour12:false}))"
```
(Replace `TIMEZONE` with the contact's timezone, e.g., `Asia/Shanghai`.)

**If current hour is BETWEEN workingHours.start AND workingHours.end:**
Proceed to Step 3.5 (Send Immediately).

**If current hour is OUTSIDE working hours:**
1. Calculate the next working-hour start time in the prospect's timezone.
2. Display: "⏰ {prospect}'s local time is {HH}:00 — outside working hours ({start}:00-{end}:00). Scheduling delivery for {next working hour start} their time."
3. Instead of sending now, **schedule** the email:
   - INSERT into email_log with `status = 'scheduled'`, `scheduled_at = '{next start ISO}'`
   - Log timeline: "Outreach email scheduled for {time} ({prospect}'s timezone)"
   - Display: "Email scheduled. It will be sent automatically at {time} ({timezone})."
4. **END FLOW HERE** — do NOT proceed to Step 3.5.
5. Send the email when the scheduled time arrives (the next Skill invocation or cron-triggered check will handle it).

**If timezone is unknown (null):**
Warn the user: "⚠️ No timezone set for this contact. Email will be sent immediately."
Proceed to Step 3.5.

### Step 3.5: Send the Email (Immediately)

Generate a unique Message-ID:
`<{contact_id}.{timestamp}@crm-outreach>`

Call the email MCP server:
```
mcp__email__send_email:
  to: {email}
  subject: "{subject}"
  body: "{body}"
  messageId: "<{contact_id}.{timestamp}@crm-outreach>"
```

### Step 3.6: Record the Outbound Email

If send succeeds:
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, subject, body, status, sent_at)
   VALUES (?, 'outbound', ?, ?, ?, 'sent', datetime('now'))"
```

Update the workflow state:
```
mcp__sqlite__write_query:
  "UPDATE workflow_state SET state = 'EMAIL_SENT', last_action = 'Outreach email sent',
   state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```

Log the timeline event:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'email_sent', 'Outreach email sent: \"{subject}\"', ?)"
```

### Step 3.7: Display Summary

"Email sent successfully to {name} ({email}). Current state: EMAIL_SENT.
You can check for replies anytime by running `/card-followup` and selecting 'Check for new replies'."

Return to main menu.

**If send fails:**
Display the error. Log as timeline event with event_type='error'. Offer retry or return to main menu.
- If `im.enabled` AND `im.notifications.systemError`:
  Run `cc-connect send --project crm -m "❌ Outreach email failed for {name} ({email})\nError: {error_summary}"` (fire-and-forget).

---

## Phase 4: Reply Checking

**Before checking replies, clean up expired approvals:**
```sql
mcp__sqlite__read_query:
  "SELECT pa.id, c.name, c.email FROM pending_approvals pa
   JOIN contacts c ON pa.contact_id = c.id
   WHERE pa.status = 'pending' AND pa.expires_at < datetime('now')"
```
For each expired record:
```sql
mcp__sqlite__write_query:
  "UPDATE pending_approvals SET status = 'expired' WHERE id = ?"
```
Log timeline: `event: draft_expired, description: "IM approval draft expired — {name} ({email})"`

### ⚡ Auto-Check Mode (cron-triggered)

**If the skill was invoked with "auto-check" or "automatically" in the arguments**
(triggered by system cron via `scripts/auto-check.sh`), do NOT process replies inline. Instead,
spawn a sub-agent to do all the work in an isolated context. This keeps the
main conversation context clean across hundreds of cycles.

The sub-agent has full access to: IMAP polling, SQLite DB, KB documents
(`references/knowledge-base/`), email templates (`references/templates/`),
and SMTP sending. It can independently: check replies → match contacts →
classify intent → read KB → compose auto-reply → send → record.

```
Agent tool:
  description: "Auto-check IMAP replies"
  subagent_type: "general-purpose"
  prompt: |
    Auto-check email replies. Config: references/crm-settings.json.
    KB docs: references/knowledge-base/*.md.
    Templates: references/templates/interested-reply.md.
    Email server: scripts/email-mcp-server/config.json.

    1. Read config (lastCheckedAt, language, autoApproveDrafts)
    2. Poll IMAP for unseen messages since lastCheckedAt
    3. For each NEW message (dedup by message_id):
       a. FILTER: skip system notifications (Alibaba Cloud, Tencent/QQ service,
          bounce/undelivered, 欠费/额度不足) before any matching
       b. THREE-TIER MATCHING (try all, only skip if ALL fail):
          Tier 1: Match by In-Reply-To/References → email_log.message_id
          Tier 2: Match by sender email → contacts.email
          Tier 3: COLD INBOUND — auto-create contact, detect timezone,
                  record as event_type='cold_inbound'
       c. Check existing contact state (skip this check for cold inbounds —
          new contacts always start at NEW, never terminal):
          - HANDED_OVER: Record the reply (email_log + timeline with
            event_type='reply_recorded', description noting "Post-handoff
            reply — recorded only, no auto-processing") then SKIP intent
            classification and auto-reply. Do NOT change workflow state.
            The follow-up person is handling this conversation manually.
          - NOT_INTERESTED/EXITED: Skip entirely (do not record).
       d. Record inbound (email_log + timeline)
       e. Classify intent with AI semantic analysis (NOT keyword matching).
          Read the full reply body and understand the prospect's true intent
          considering context, tone, negation, and specific asks.
          - Detect auto-replies/OOO (check Auto-Submitted header, OOO patterns,
            vacation responders): classify as NOT_INTERESTED, reason "auto-reply/OOO"
          - Do NOT send auto-reply to auto-replies
          - Classify auto-replies as NOT_INTERESTED even if they contain
            interested-sounding keywords (avoid reply loops)
       e2. BEFORE sending auto-reply, check auto-reply count for this contact:
          Query: SELECT COUNT(*) as cnt FROM email_log
                 WHERE contact_id = ? AND direction = 'outbound'
                 AND status = 'handed_over'
          If cnt >= 3:
            * Read previous email subjects and this inbound email body.
            * Determine if this reply introduces a SUBSTANTIALLY NEW TOPIC
              (new product category, new question type, new phase of
              conversation — e.g., moving from pricing to shipping, or
              from product A to product B).
            * If NEW TOPIC detected:
              - Log timeline: "New topic detected — resetting auto-reply
                counter for {name}. Previous: {summary of old topic},
                New: {summary of new topic}."
              - Proceed to auto-reply (reset effectively — the new
                auto-reply addresses the new topic).
            * If SAME TOPIC (just continuing the same thread):
              - Log timeline: "Auto-reply limit reached (3) on same topic
                — human review required."
              - Update workflow_state to HANDED_OVER with note:
                "Human review required after 3 auto-replies on same topic."
              - Do NOT send auto-reply. Proceed to next message.
          If cnt < 3: proceed to auto-reply normally.
       e3. Check for reply loop: if this contact's reply arrived within 5 minutes
          of our last outbound email, AND this would be the 2nd+ auto-reply in
          this thread, flag for human review instead of auto-replying.
       f. If interested AND autoApproveDrafts is ON:
          - Read ALL previous email_log entries for this contact FIRST
            (query by contact_id, ORDER BY sent_at/received_at ASC)
          - For cold inbounds (Tier 3): attempt to fetch the prospect's
            company website via WebFetch to understand their business
          - Read all KB docs + interested-reply template
          - Compose auto-reply that: references conversation history,
            matches tone of previous exchanges, addresses unresolved
            items, and **MUST** include the full quoted original email
            (using '> ' prefix) below every reply. This is NOT optional —
            every auto-reply requires the full quoted original email for
            conversation context. Format:
            On {date}, {original sender} wrote:
            > {quoted email body}
          - Self-check before sending:
            □ Referenced something specific from a previous email?
            □ Answered ALL questions the prospect asked?
            □ Quoted original email included below reply? (MUST — do not skip)
          - Send via SMTP (scripts/email-mcp-server)
          - If send SUCCEEDS:
            * Record outbound in email_log (status = 'handed_over')
            * Update workflow_state to HANDED_OVER
            * Log timeline: "Auto-reply sent."
            * Send handoff notification email: randomly pick one teamMembers
              member, send a fixed-template "[CRM Handoff] {name} @ {company}"
              email (with contact/intent/conversation summary), and log
              timeline event_type='handoff_notified'.
          - If send FAILS:
            * Log timeline: "Auto-reply failed — will retry"
            * Keep state as INTERESTED (do NOT advance to HANDED_OVER)
            * Increment retry_count in workflow_state
            * If retry_count >= 3: give up, update state to HANDED_OVER
              with note "Auto-reply failed after 3 retries — human
              attention needed.", log timeline event.
            * NOTE: Because the inbound message is already recorded in
              email_log, it won't be re-processed via the main message
              loop. Instead, a RETRY STEP at the end of the cycle
              handles pending auto-replies (see step 4.5 below).
    4. Update lastCheckedAt to the current ISO timestamp.
       ...
    4.5. RETRY FAILED AUTO-REPLIES:
       Query for contacts with pending auto-replies:
         SELECT DISTINCT e.contact_id
         FROM email_log e
         JOIN workflow_state ws ON e.contact_id = ws.contact_id
         WHERE ws.state = 'INTERESTED'
         AND e.direction = 'inbound'
         AND e.intent = 'interested'
         AND ws.retry_count < 3
         AND e.id NOT IN (
           SELECT CAST(e2.in_reply_to AS INTEGER) FROM email_log e2
           WHERE e2.direction = 'outbound' AND e2.in_reply_to IS NOT NULL
         )
       For each pending contact: re-read KB, compose auto-reply based
       on the original inbound email, and attempt to send.
       On success: record outbound (in_reply_to = original inbound
       message_id), update state to HANDED_OVER, reset retry_count = 0.
       Also send handoff notification email to a randomly picked teamMembers
       member (with contact/intent/conversation summary), and log timeline
       event_type='handoff_notified'.
       On failure: increment retry_count, log timeline.
    4. Update lastCheckedAt to the current ISO timestamp.
       NOTE: This MUST happen AFTER all messages are processed (step 3),
       not before. If the process crashes mid-way, messages will be
       re-fetched on the next run but deduplicated by message_id — safe
       to over-fetch. The dedup check in step 3 prevents duplicates.
    5. Return CONCISE 1-line summary per reply. For cold inbounds, prefix with "🆕"

Note: Auto-reply in auto-check mode SKIPS the working-hours check
(Step 3.4). The prospect just replied — they are at their computer.
Send immediately.
```

When the agent returns, display a one-line summary:
- No replies: "[auto-check {HH:MM}] No new replies."
- With replies: "[auto-check {HH:MM}] {N} new — {name} ({intent}, auto-reply: {sent/held})"

That's it. The sub-agent handles everything — do NOT run Phase 5 or Phase 6 in
the main context for auto-check mode.

If the Agent tool is unavailable, fall back to manual inline processing below.

### Manual Mode (user-initiated)

### Step 4.1: Check Inbox

Use the default lookback (7 days).

Call the email MCP server:
```
mcp__email__check_replies: { since: "last 7 days" }
```

If no messages found: "No new replies found." Return to main menu.

If messages found: Display a summary:
"Found {count} new message(s):"

For each message, show:
- From
- Subject
- Date
- First 100 characters of body

### Step 4.2: Match Replies to Contacts (Three-Tier Matching)

For each reply, follow this three-tier matching strategy. Only skip a message
if ALL three tiers fail.

**IMPORTANT: Before matching, filter out system notifications and auto-replies.**
Check the sender address and subject for known patterns:
- `*@notice.aliyun.com`, `*@notice.alibaba.com` → Alibaba Cloud notifications, skip
- `*@mail.qq.com`, `*@service.qq.com` → QQ/Tencent service notices, skip
- Subject matches `*退信*`, `*bounce*`, `*undelivered*`, `*额度不足*`, `*欠费*` → skip
- Any message with `Auto-Submitted: auto-replied` or `Auto-Submitted: auto-generated` header → treat as auto-reply, classify NOT_INTERESTED in Phase 5 but still process if matched to a contact

---

#### Tier 1: Message-ID Chain Match (Thread-Based)

Extract `inReplyTo` and `references` from the response.
Try to match against sent emails in `email_log`:

```
mcp__sqlite__read_query:
  "SELECT e.id as email_id, e.contact_id, e.message_id, c.name, c.email, c.company,
          ws.state
   FROM email_log e
   JOIN contacts c ON e.contact_id = c.id
   LEFT JOIN workflow_state ws ON c.id = ws.contact_id
   WHERE e.message_id = ?
      OR e.message_id IN ({comma-separated references})
   ORDER BY e.sent_at DESC
   LIMIT 1"
```

**If match found in Tier 1:**
- Record the inbound email:
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
   VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
```
- Log timeline event:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'reply_received', 'Reply received from {name}: \"{first 80 chars of body}\"', ?)"
```
- If `im.enabled` AND `im.notifications.newReply`:
  Run `cc-connect send --project crm -m "📨 {name} ({company}) replied!\nSubject: {subject}"` (fire-and-forget).
- Proceed to Phase 5 for this contact.

---

#### Tier 2: Sender Email Match (Contact-Based Fallback)

If Tier 1 fails (no Message-ID chain match), extract the sender's email address
from the message `from` field. Try to find a matching contact:

```
mcp__sqlite__read_query:
  "SELECT c.id, c.email, c.name, c.company, c.title, c.created_at,
          ws.state, ws.last_action
   FROM contacts c
   LEFT JOIN workflow_state ws ON c.id = ws.contact_id
   WHERE c.email = ?"
```

**If match found in Tier 2:**
This means an existing contact replied, but the Message-ID chain broke
(e.g., they used a different email client or replied from a forwarded message).

- Record the inbound email:
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
   VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
```
- Log timeline event:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'reply_received', 'Reply received from {name} (matched by sender email, Message-ID chain broken): \"{first 80 chars of body}\"", ?)"
```
- If `im.enabled` AND `im.notifications.newReply`:
  Run `cc-connect send --project crm -m "📨 {name} ({company}) replied (matched by sender email)!\nSubject: {subject}"` (fire-and-forget).
- Proceed to Phase 5 for this contact.

---

#### Tier 3: Cold Inbound — New Prospect (Auto-Create Contact)

If both Tier 1 and Tier 2 fail, this is a **cold inbound**: someone who has
never been in the CRM is reaching out proactively.

**Do NOT skip this message.** Instead, treat it as a new lead:

**Step 4.2.3a: Extract contact info from the email**

Parse the `from` field to extract name and email address. Common formats:
- `"Name" <email@domain.com>`
- `Name <email@domain.com>`
- `email@domain.com` (name unknown)

If a name is present, use it. If only email is available, use the
email username (part before `@`) as a display name placeholder.

Try to infer company from the email domain:
- Extract the domain (e.g., `@acmecorp.com` → `acmecorp.com`)
- Use the domain as a provisional company name (can be updated later)

**Step 4.2.3b: Create the contact record**

```
mcp__sqlite__write_query:
  "INSERT INTO contacts (email, name, company, title) VALUES (?, ?, ?, ?)"
```

Create workflow state (starting at NEW):
```
mcp__sqlite__write_query:
  "INSERT INTO workflow_state (contact_id, state) VALUES (?, 'NEW')"
```

**Step 4.2.3c: Detect timezone**
Follow the same timezone detection logic as Step 2.5 (TLD → timezone mapping).
Auto-assign without asking (silent, since this is automated reply processing).
If can't determine, use `defaultTimezone` from crm-settings.json.

```
mcp__sqlite__write_query:
  "UPDATE contacts SET timezone = ? WHERE id = ?"
```

**Step 4.2.3d: Record the inbound email**
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
   VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
```

**Step 4.2.3e: Log timeline**
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'cold_inbound', '🔔 Cold inbound — new prospect reached out proactively. Subject: \"{subject}\". From: {name} ({email})', ?)"
```

**Step 4.2.3f: Notify the user**
Display prominently:
```
🔔 NEW LEAD: {name} ({email}) reached out proactively!
   Subject: {subject}
   Auto-created contact record. Proceeding to intent classification.
```

- If `im.enabled` AND `im.notifications.coldInbound`:
  Run `cc-connect send --project crm -m "🆕 New Lead! {name} ({email}) reached out proactively\nSubject: {subject}"` (fire-and-forget).

**Step 4.2.3g: Proceed to Phase 5**
Classify intent and (if interested) auto-reply just like any matched reply.

---

**If ALL three tiers fail** (e.g., can't even parse a valid sender email):
Display: "Message from {from} ({subject}) — could not parse sender or match to any contact. Skipping."
Skip this message and continue processing others.

### Step 4.2b: Check for Post-Handoff Contacts

**Before proceeding to Phase 5 for each matched reply**, check the contact's
current workflow state:

- **If state is HANDED_OVER:** This contact has already been handed over to a
  human follow-up person. The follow-up person is now communicating with the
  prospect outside the CRM. **Record the reply but do NOT process further:**
  ```
  mcp__sqlite__write_query:
    "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
     VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
  ```
  ```
  mcp__sqlite__write_query:
    "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
     VALUES (?, 'reply_recorded', '📝 Post-handoff reply recorded (no auto-processing): \"{first 80 chars of body}\"', ?)"
  ```
  Display: "📝 Reply from {name} ({email}) recorded. Contact is in HANDED_OVER —
  follow-up person is handling this conversation. No auto-processing."
  **Skip Phase 5 and Phase 6** for this contact. Continue to the next message.

- **If state is NOT_INTERESTED or EXITED:** Skip entirely. Do not record.

### Step 4.3: Process Each Matched Reply

For each matched reply, proceed through Phase 5 (intent classification).
Then, for interested prospects, proceed through Phase 6 (auto-reply).

After processing all replies, display a batch summary:
"Processed {n} replies: {x} interested, {y} not interested."
Return to main menu.

---

## Phase 5: Intent Classification

### Step 5.1: AI Semantic Intent Classification

**Use AI semantic analysis to understand the prospect's true intent.**
Read the complete reply body and reason about the prospect's meaning.
Do NOT use keyword matching — keywords can be misleading
(e.g., "价格" in "价格太贵不需要" = not_interested, not interested).

When classifying, consider:
- **Context and tone**: Is the prospect enthusiastic, neutral, dismissive?
- **Negation patterns**: "not interested in the price but the product is great"
  = interested but price-sensitive, NOT not_interested
- **Conditional language**: "if you can do X, then we might consider" = interested
- **Specific asks**: pricing, demo, sample, meeting, shipping — concrete asks
  signal genuine interest
- **Mixed signals**: "not right now but reach out next quarter" = interested with
  timing note. "wrong person but contact X" = interested (gave a referral)

**Analysis checklist:**
1. What is the prospect actually asking for? (concrete request vs vague response)
2. Is there an underlying need even if the surface tone is negative?
3. Would a reasonable salesperson follow up on this or close the lead?
4. Is there any signal that should override keyword-level analysis?

**Auto-reply/OOO detection (check BEFORE intent classification):**
- Auto-Submitted header values: `auto-replied`, `auto-generated` → NOT_INTERESTED
- Body patterns: "out of office", "vacation", "annual leave", "on leave",
  "away from", "休假", "外出", "出差", "I will be back on", "returning on",
  "limited access to email" → NOT_INTERESTED, reason "auto-reply/OOO"
- Do NOT send auto-reply to an auto-reply under ANY circumstances

**Reply loop detection:**
- Query the last outbound for this contact: if sent within 5 minutes of this
  reply AND this is already the 2nd+ exchange → NOT_INTERESTED, reason
  "reply loop detected". Do NOT send another auto-reply.

**IMPORTANT: Classify auto-replies as NOT_INTERESTED even if they contain
interested-sounding keywords (avoid reply loops with other auto-responders).**

### Step 5.2: Record the Classification

```
mcp__sqlite__write_query:
  "UPDATE email_log
   SET intent = ?, intent_reason = ?, status = 'intent_classified'
   WHERE id = ?"
```

Update workflow state:
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET state = ?, last_action = ?, state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```
Where state is `INTERESTED` or `NOT_INTERESTED`.

Log timeline event:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'intent_analyzed', 'Intent: {intent}. Reason: {reason}', ?)"
```

### Step 5.3: Display Classification Result

"Reply from {name} ({email}):
Intent: {INTERESTED or NOT_INTERESTED}
Reason: {explanation in one sentence}
Reply summary: {first 100 chars of reply body}"

**If NOT_INTERESTED:**
"This prospect has been marked as NOT_INTERESTED. No further action needed."
Return to processing next reply or main menu.

**If INTERESTED:**
Proceed automatically to Phase 6.
- If `im.enabled` AND `im.notifications.interestedIntent`:
  Run `cc-connect send --project crm -m "✅ {name} ({company}) is INTERESTED!\nReason: {reason}\nSummary: {first 100 chars of reply body}"` (fire-and-forget).

---

### Step 5.4: Auto-Reply Limit Guard (SAFETY VALVE)

**IMPORTANT: Before proceeding to Phase 6 auto-reply, check whether we have
already sent too many auto-replies to this contact. Hard limit: 3 auto-replies
per contact. This prevents infinite conversation loops and ensures human
oversight for extended exchanges.**

1. **Query the outbound auto-reply count** for this contact:
   ```
   mcp__sqlite__read_query:
     "SELECT COUNT(*) as cnt FROM email_log
      WHERE contact_id = ? AND direction = 'outbound' AND status = 'handed_over'"
   ```

2. **If count >= 3:**
   - Read previous email subjects and this inbound email body to compare topics.
   - **Determine if this reply introduces a SUBSTANTIALLY NEW TOPIC:**
     * New product category or product line
     * New question type (e.g., switching from pricing to shipping)
     * New business phase (e.g., from inquiry to order discussion)
     * Different use case or customer segment
   - **If NEW TOPIC detected:**
     * Log timeline:
       ```
       mcp__sqlite__write_query:
         "INSERT INTO timeline (contact_id, event_type, description)
          VALUES (?, 'auto_reply_limit',
          'New topic detected — resetting auto-reply counter. Old: {summary}, New: {summary}')"
       ```
     * Proceed normally to Phase 6 (the new topic justifies a fresh auto-reply).
   - **If SAME TOPIC (continuing the same thread):**
     * Log timeline:
       ```
       mcp__sqlite__write_query:
         "INSERT INTO timeline (contact_id, event_type, description)
          VALUES (?, 'auto_reply_limit',
          'Auto-reply limit reached (3 sent) on same topic. Human review required.')"
       ```
     * Update workflow state:
       ```
       mcp__sqlite__write_query:
         "UPDATE workflow_state
          SET state = 'HANDED_OVER',
              last_action = 'Auto-reply limit reached (3). Human review required.',
              state_entered_at = datetime('now'),
              updated_at = datetime('now')
          WHERE contact_id = ?"
       ```
     * Display: "⚠️ Auto-reply limit reached (3) — manual follow-up required for {name}."
     * **SKIP auto-reply.** Do NOT proceed to Phase 6.

3. **If count < 3:**
   Proceed normally to Phase 6.

---

## Phase 6: Auto-Reply for Interested Prospects

### Step 6.0: Review Conversation History (Context Continuity)

**IMPORTANT: Before composing a reply, read the full email history for this
contact to maintain conversation continuity. The prospect should feel like
they're continuing a conversation, not starting over.**

1. **Query all previous email exchanges** for this contact:

   mcp__sqlite__read_query:
     "SELECT id, direction, subject, body, sent_at, received_at, message_id, in_reply_to
      FROM email_log
      WHERE contact_id = ?
      ORDER BY COALESCE(sent_at, received_at) ASC"

2. **Read the full body** of at least the most recent 3 emails (both inbound and outbound).
   Pay special attention to:
   - What was promised or discussed in previous emails?
   - Are there any **unresolved questions** from earlier exchanges?
   - What **tone and language style** was used (formal, casual, technical)?
   - What **specific products, prices, or details** were mentioned?
   - Are there any **pending action items** that need follow-up?

3. **Match the tone** and language style of the conversation so far. If previous
   emails were formal, stay formal. If they were conversational, match that.

4. **Reference previous conversation points explicitly** — e.g., "As mentioned in
   my previous email..." or "Following up on the pricing we discussed..."

5. **If this is a cold inbound** (no previous outbound emails from us), this is
   the first time we're contacting them. Use their inbound email as the sole
   context and skip the history review.

### Step 6.1: Research Prospect (Cold Inbound) or Search Knowledge Base

**If this is a cold inbound (Tier 3 match)** and we have NOT previously
researched this prospect's website:
- Follow the website research process from **Step 3.1b** to understand their
  business before composing the reply.

**For all replies**, analyze the prospect's reply to identify specific questions
or topics. Search the knowledge base for relevant documents:

Analyze the prospect's reply to identify specific questions or topics.
Search the knowledge base for relevant documents:
```
mcp__filesystem__search_files with query terms extracted from the reply
```

Read the most relevant document(s) fully:
```
mcp__filesystem__read_file for matching documents
```

Also read the interested-reply template:
```
Read: references/templates/interested-reply.md
```

### Step 6.2: Compose Auto-Reply

**Note: Reply emails (in BOTH manual mode AND auto-check mode) skip the
working-hours check (Step 3.4). The prospect just replied — they are at
their computer and working. Send immediately regardless of their local time.**

Compose a reply that:
1. **Continues the conversation naturally** — reference previous email context
   and show you remember what was discussed before. The prospect should feel
   this is a coherent thread, not isolated messages.
2. **Thanks the prospect** for their interest
3. **Answers their specific questions** using information from the KB documents.
   If they asked multiple questions, address each one clearly.
4. **Provides relevant details** (pricing, specifications, shipping info as appropriate).
   Match the level of detail to what was previously discussed.
5. **Addresses any unresolved items** from previous emails — don't let things
   fall through the cracks. If something was promised earlier, acknowledge it.
6. **Guides toward human follow-up** with a clear transition:
   "Our sales team will follow up with you regarding {specific topic — shipping, delivery, detailed quote, etc.}. In the meantime, feel free to contact us at {contact info from KB}."
7. **Is professional and concise** — 3-4 paragraphs maximum
8. **Use the configured language** from `references/crm-settings.json` → `language`:
   `"en"` → English, `"zh"` → 中文
9. **MUST include the quoted original email below your reply**, separated by a standard
   email quote delimiter. This ensures the recipient knows exactly which conversation
   this is part of. Format:
   ```
   [Your reply text above]

   On {date}, {original sender} wrote:
   > {first line of quoted email}
   > {second line}
   > ...
   ```
   Use the full body of the prospect's reply (the inbound email_log.body).

**Context continuity checklist (self-review before presenting draft):**
- [ ] Did I reference something specific from a previous email?
- [ ] Did I answer ALL questions the prospect asked?
- [ ] Did I address any pending items or promises from earlier?
- [ ] Does the tone match the conversation history?
- [ ] Would this make sense if the prospect reads the full thread?

### Step 6.3: Present Draft for Review (or Auto-Send)

**Check `autoApproveDrafts` in `references/crm-settings.json`.**

**If autoApproveDrafts is TRUE:**
1. Display: "⚡ Auto-approve ON — sending auto-reply immediately."
2. Show the draft details (to, subject, reply body, quoted context) for logging.
3. Skip the approval question and proceed directly to Step 6.4 (Send the Auto-Reply).
4. Log a timeline note: "Auto-approved and sent without manual review."

**If autoApproveDrafts is FALSE (default):**
Present the auto-reply draft. **IMPORTANT:** The body MUST include the quoted
original email below your reply text, so the recipient sees the conversation context:

```
--- DRAFT AUTO-REPLY ---
To: {name} <{email}>
Subject: Re: {original subject}
In-Reply-To: {prospect's message-id}

{your reply text}

On {date of original email}, {original sender} wrote:
> {quoted original email, each line prefixed with >}
--- END DRAFT ---
```

Ask user: "Approve this auto-reply?"
Use `AskUserQuestion`: "Send as-is", "Edit", "Skip (don't send auto-reply)".

### Step 6.4: Send Auto-Reply

If approved:
```
mcp__email__send_email:
  to: {email}
  subject: "Re: {original subject}"
  body: "{body}"
  messageId: "<{contact_id}.{timestamp}.reply@crm-outreach>"
  inReplyTo: "{prospect's message-id}"
```

### Step 6.5: Record and Finalize

**If send SUCCEEDS:**
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, sent_at, kb_doc_used)
   VALUES (?, 'outbound', ?, ?, ?, ?, 'handed_over', datetime('now'), ?)"
```

Update workflow state (reset retry_count):
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET state = 'HANDED_OVER', last_action = 'Auto-reply sent. Awaiting human follow-up.',
   retry_count = 0, state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```

Log timeline:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'handed_over', 'Auto-reply sent. REMINDER: Human follow-up required for shipping/delivery.', ?)"
```

- If `im.enabled` AND `im.notifications.autoReplySent`:
  Run `cc-connect send --project crm -m "✉️ Auto-reply sent to {name} ({email})\nStatus: HANDED_OVER\n⚠️ Human follow-up needed for shipping/delivery"` (fire-and-forget).

**Send handoff notification email to a team member (auto-handoff, no toggle, ALWAYS send):**

After the auto-reply succeeds, randomly pick one member from
`references/crm-settings.json` → `teamMembers` and send a fixed-template handoff notification email:

1. Read `teamMembers` array, randomly pick one (if only one member, pick that one).
2. Generate a conversation summary (reuse the "Handoff Prospect to Team Member"
   H2 summary format: timeline key points + email discussion points + intent +
   outstanding questions + suggested next steps).
3. Send the notification email:
```
mcp__email__send_email:
  to: {team member email}
  subject: "[CRM Handoff] {name} @ {company} — auto-reply sent, human follow-up needed"
  body: "Contact: {name} ({email})
Company: {company}
Intent: interested
State: HANDED_OVER (auto-reply sent)

Conversation Summary:
{summary}

Suggested next step: follow up on shipping/delivery details.
—— This email was auto-generated by the CRM"
```
4. Log timeline: `event_type='handoff_notified'`, description "Handoff notification email sent to {team member name} ({email})".

**If send FAILS:**
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET retry_count = retry_count + 1, last_action = 'Auto-reply failed — will retry',
   updated_at = datetime('now')
   WHERE contact_id = ?"
```

- Log timeline: "Auto-reply send failed (attempt {retry_count}/3). Will retry on next check."
- If retry_count >= 3:
  - Update state to HANDED_OVER: last_action = "Auto-reply failed after 3 retries — human attention needed."
  - Log timeline: "Auto-reply permanently failed after 3 retries. Human review required."
  - Display: "❌ Auto-reply failed 3 times for {name} — manual follow-up required."
- Keep state as INTERESTED (so the retry query picks it up next cycle).
- Display the error and offer retry or return to main menu.

### Step 6.6: Display Final Summary

"Auto-reply sent to {name} ({email}).
Status: HANDED_OVER
⚠️ REMINDER: Human follow-up is now needed for shipping and delivery arrangements."

Return to main menu.

---

## Additional Operations

### View Contact Status

When the user selects "View contact/prospect status" from the main menu,
ask for an email address, then query:

```
mcp__sqlite__read_query:
  "SELECT c.*, ws.state, ws.last_action, ws.state_entered_at
   FROM contacts c
   LEFT JOIN workflow_state ws ON c.id = ws.contact_id
   WHERE c.email = ?"
```

Display all information including timeline events:
```
mcp__sqlite__read_query:
  "SELECT * FROM timeline WHERE contact_id = ? ORDER BY created_at DESC LIMIT 10"
```

### Manually Re-classify

When the user selects "Manually re-classify" from the main menu:
1. Ask for the contact's email address
2. Look up the contact (same query as View Contact Status)
3. Show current state
4. Ask what state to change to (use AskUserQuestion with valid states: INTERESTED, NOT_INTERESTED, HANDED_OVER, EXITED)
5. Update workflow_state and log timeline event

### Handoff Prospect to Team Member

When the user selects "Handoff prospect to team member" from the main menu:

**Step H1: Identify the prospect**
1. Ask for the prospect's email address.
2. Look up the contact (same query as View Contact Status).
3. Display current state, recent timeline events, and email history.

**Step H2: Generate conversation summary**
Read all timeline events and email_log entries for this contact. Generate a
structured summary in the **configured language**:

```
--- CONVERSATION SUMMARY ---
Contact: {name}, {company}, {email}
Current State: {state}

Timeline:
• [date] {event_type}: {description}
• [date] {event_type}: {description}
...

Key Discussion Points:
- {point 1 from email exchange}
- {point 2 from email exchange}

Prospect Intent: {interested / not_interested}
Outstanding Questions: {any unanswered questions from prospect}
Suggested Next Steps for Human: {recommendation}
--- END SUMMARY ---
```

Store this summary as `conversation_summary` in the handoffs table.

**Step H3: Select team member**
Read `references/crm-settings.json` → `teamMembers`. Show as options via
`AskUserQuestion`, displaying each member's name and role.

**Step H4: Collect instructions**
Ask the user: "Any specific instructions or notes for {team member name}?"
This is free-text, optional. Default to: "Please follow up with {name} at
{company} regarding {summary of their interest}. Contact: {email}."

**Step H5: Record the handoff**
```
mcp__sqlite__write_query:
  "INSERT INTO handoffs (contact_id, assigned_to, assigned_email, status, conversation_summary, instructions)
   VALUES (?, ?, ?, 'pending', ?, ?)"
```

Update workflow state if not already HANDED_OVER:
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET state = 'HANDED_OVER', last_action = 'Handed off to {assigned_to}',
       state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```

Log timeline:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description)
   VALUES (?, 'handed_over', 'Handed off to {assigned_to} ({assigned_email}). Instructions: {instructions}')"
```

**Step H6: Confirmation**
Display:
```
✅ Handoff recorded:
- Prospect: {name} ({email})
- Assigned to: {team member name} ({email})
- Status: pending
- Instructions: {instructions}

⚠️ REMINDER: Notify {team member name} to take over this prospect. The
conversation summary above can be shared with them for context.
```

**Optional: Send notification email**
Ask the user: "Send a notification email to {team member name} with the
conversation summary?"

If yes:
```
mcp__email__send_email:
  to: {team member email}
  subject: "[CRM Handoff] {name} @ {company} — {intent summary}"
  body: {conversation summary + instructions}
```
Update handoff status to `notified`.

Return to main menu.

### Setup/Verify System

When the user selects "Setup/Verify system":
1. Check database tables exist:
   ```
   mcp__sqlite__list_tables
   ```
2. If tables are missing, create them by running each CREATE TABLE statement from
   the list in `scripts/setup-db.js`. Use `mcp__sqlite__create_table` (preferred)
   or `mcp__sqlite__write_query`.
3. Verify email connectivity:
   ```
   mcp__email__verify_connection
   ```
4. Report: "Database: {OK or tables created}. SMTP: {OK/error}. IMAP: {OK/error}."

---

## Key Rules

1. **ALWAYS show drafts for human approval** before sending any email (outreach or auto-reply).
2. **ALWAYS check deduplication** (Phase 2.2) before creating a new contact.
3. **ALWAYS log every action** in the timeline table.
4. **NEVER send an auto-reply to an auto-reply** — detect OOO/auto-responders in Phase 5.
5. **Handle errors gracefully** — if email send fails, log the error in timeline, offer retry.
6. **Use the `allowed-tools` from this skill's frontmatter** — all listed tools are pre-approved
   and do not require permission prompts.
7. **Use the configured language for all emails** — check `language` in `crm-settings.json`.
   `"en"` (default) for English, `"zh"` for Chinese (中文).
8. **ALWAYS include quoted original email in replies** — every auto-reply (Phase 6) must append
   the prospect's original email as a quoted block (`> ` prefix) below your new text.
   The recipient must be able to see which conversation this is a response to.
9. **Keep the user informed** — always show what happened and what state the contact is in.
10. **Use fully-qualified MCP tool names** — e.g., `mcp__sqlite__write_query`, not just `write_query`.
11. **When in doubt, ask the user** — especially for editing drafts or handling edge cases.
12. **ALWAYS research the prospect's company website** before sending cold outreach (Step 3.1b).
    Use WebFetch to understand their industry, products, and market position. Tailor product
    recommendations to their specific business profile.
13. **ALWAYS review conversation history** before composing a reply (Step 6.0). Read at least
    the last 3 email exchanges for context. Reference previous discussion points, match the
    conversation tone, and address any unresolved questions or pending items.
14. **Post-handoff replies are RECORD-ONLY.** When a contact is in HANDED_OVER state, any
    further replies (from prospect or follow-up person) must be recorded to email_log and
    timeline (event_type='reply_recorded') but MUST NOT trigger intent classification (Phase 5)
    or auto-reply (Phase 6). The follow-up person is handling the conversation manually.
    Do NOT change the workflow state — leave it as HANDED_OVER.
