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

1. **Input new business card and send outreach email** — Phases 2-3
2. **Check for new replies** — Phases 4-6
3. **View contact/prospect status** — Quick status lookup
4. **Handoff prospect to team member** — Transfer to human with context summary
5. **Setup/verify system** — Initialize database or test email connection

The last three options should be toggles:
- Toggle auto-approve: "⚡ Enable auto-approve" or "🔍 Disable auto-approve"
- Toggle language: "🌐 Switch to 中文" or "🌐 Switch to English"
- Toggle auto-polling: "🔄 Enable auto-polling" or "⏸ Disable auto-polling"

When the user selects a toggle:
1. Read `references/crm-settings.json`
2. Flip the corresponding value. For auto-polling, flip `autoReplyPolling.enabled`.
3. If ENABLING auto-polling: also use `CronCreate` to schedule the recurring check.
   The cron prompt should be: "/card-followup automatically check for replies and process them.
   If autoApproveDrafts is ON, send auto-replies immediately. If OFF, just record replies and classify intent."
   Use the interval from `autoReplyPolling.intervalMinutes`.
4. If DISABLING auto-polling: use `CronDelete` to cancel the auto-polling cron job.
   (Store the job ID in crm-settings.json under `autoReplyPolling.cronJobId` for later deletion.)
5. Write back to the file.
6. Display confirmation.
7. Re-display the main menu.

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

### Step 3.2: Analyze Prospect & Generate Draft

Based on the contact info (name, company, title) and the knowledge base content,
analyze the prospect and generate a personalized outreach email.

Your analysis should consider:
- What industry is this company in? What are their likely needs?
- Which products/services from the KB are most relevant?
- What is a compelling subject line that would get this person to open?
- Keep the email concise (3-4 paragraphs max), professional, and warm.

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
5. The daemon (`auto-reply-daemon.js`) will pick up scheduled emails and send them.

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

---

## Phase 4: Reply Checking

### ⚡ Auto-Check Mode (cron-triggered)

**If the skill was invoked with "auto-check" or "automatically" in the arguments**
(which is how CronCreate triggers it), do NOT process replies inline. Instead,
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
       c. Skip if existing contact is in terminal state
          (HANDED_OVER/NOT_INTERESTED/EXITED) — UNLESS this is a cold inbound
          (new contacts always start at NEW, never terminal)
       d. Record inbound (email_log + timeline)
       e. Classify intent with AI reasoning
          - Detect auto-replies/OOO: classify as NOT_INTERESTED, reason "auto-reply/OOO"
          - Do NOT send auto-reply to auto-replies
       f. If interested AND autoApproveDrafts is ON:
          - Read all KB docs + interested-reply template
          - Compose auto-reply with quoted original email
          - Send via SMTP (scripts/email-mcp-server)
          - Record outbound + update state to HANDED_OVER
    4. Update lastCheckedAt
    5. Return CONCISE 1-line summary per reply. For cold inbounds, prefix with "🆕"
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

**Step 4.2.3g: Proceed to Phase 5**
Classify intent and (if interested) auto-reply just like any matched reply.

---

**If ALL three tiers fail** (e.g., can't even parse a valid sender email):
Display: "Message from {from} ({subject}) — could not parse sender or match to any contact. Skipping."
Skip this message and continue processing others.

### Step 4.3: Process Each Matched Reply

For each matched reply, proceed through Phase 5 (intent classification).
Then, for interested prospects, proceed through Phase 6 (auto-reply).

After processing all replies, display a batch summary:
"Processed {n} replies: {x} interested, {y} not interested."
Return to main menu.

---

## Phase 5: Intent Classification

### Step 5.1: Classify the Reply

Read the complete reply body. Based on the content, classify the intent as
`interested` or `not_interested`.

**INTERESTED indicators:**
- Asks about pricing, features, or specifications
- Requests a demo, trial, or sample
- Wants to schedule a call or meeting
- Expresses positive sentiment: "interested", "tell me more", "sounds good"
- Asks about shipping, delivery, or lead times
- Mentions a specific need or project timeline
- Asks for a quote or proposal
- Forwards the email to a colleague (secondary interest signal)

**NOT_INTERESTED indicators:**
- Explicitly declines: "not interested", "no thanks", "we're all set"
- Says it's not the right time: "maybe later", "not now", "next quarter"
- Wrong person: "this isn't my area", "please contact {someone else}"
- Auto-reply / out-of-office (check for "Auto-Submitted" headers or OOO patterns in body)
- Unsubscribe requests
- Hostile or spam responses

**IMPORTANT: If you detect an auto-reply or out-of-office message, classify as
`not_interested` but note the reason as "auto-reply/OOO". Do NOT send an auto-reply
to an auto-reply.**

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

---

## Phase 6: Auto-Reply for Interested Prospects

### Step 6.1: Search Knowledge Base

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

**Note: Reply emails skip the working-hours check (Step 3.4). The prospect
just emailed — they are at their computer. Send immediately.**

Compose a reply that:
1. **Thanks the prospect** for their interest
2. **Answers their specific questions** using information from the KB documents
3. **Provides relevant details** (pricing, specifications, shipping info as appropriate)
4. **Guides toward human follow-up** with a clear transition:
   "Our sales team will follow up with you regarding {specific topic — shipping, delivery, detailed quote, etc.}. In the meantime, feel free to contact us at {contact info from KB}."
5. **Is professional and concise** — 3-4 paragraphs maximum
6. **Use the configured language** from `references/crm-settings.json` → `language`:
   `"en"` → English, `"zh"` → 中文
7. **MUST include the quoted original email below your reply**, separated by a standard
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

On success:
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, sent_at, kb_doc_used)
   VALUES (?, 'outbound', ?, ?, ?, ?, 'handed_over', datetime('now'), ?)"
```

Update workflow state:
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET state = 'HANDED_OVER', last_action = 'Auto-reply sent. Awaiting human follow-up.',
   state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```

Log timeline:
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'handed_over', 'Auto-reply sent. REMINDER: Human follow-up required for shipping/delivery.', ?)"
```

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
