/**
 * Auto-Reply Daemon — Standalone background process for 24/7 email monitoring.
 *
 * Polls IMAP inbox every N minutes, matches replies to contacts, classifies
 * intent, and optionally sends auto-replies (if autoApproveDrafts is ON).
 *
 * Runs independently of Claude Code. All actions are logged to the database.
 *
 * Usage:
 *   node scripts/auto-reply-daemon.js              # run in foreground
 *   node scripts/auto-reply-daemon.js --once       # check once and exit
 *
 * Config:
 *   - references/crm-settings.json → autoReplyPolling (interval, enabled)
 *   - scripts/email-mcp-server/config.json → SMTP/IMAP credentials
 *   - references/knowledge-base/ → KB docs for reply context
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

// ─── Paths ────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..");
const CRM_SETTINGS_PATH = path.join(ROOT, "references", "crm-settings.json");
const EMAIL_CONFIG_PATH = path.join(
  ROOT,
  "scripts",
  "email-mcp-server",
  "config.json"
);
const DB_PATH = path.join(ROOT, "data", "crm.db");
const KB_DIR = path.join(ROOT, "references", "knowledge-base");

// ─── Lazy-load heavy deps ─────────────────────────────────
let initSqlJs, nodemailer, ImapFlow;

function requireDeps() {
  if (!initSqlJs) initSqlJs = require("sql.js");
  if (!nodemailer) nodemailer = require("nodemailer");
  if (!ImapFlow) {
    ImapFlow = require("imapflow").ImapFlow;
  }
}

// ─── Load configs ─────────────────────────────────────────

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadKbDocs() {
  const docs = {};
  if (!fs.existsSync(KB_DIR)) return docs;
  const files = fs.readdirSync(KB_DIR).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    docs[f.replace(".md", "")] = fs.readFileSync(path.join(KB_DIR, f), "utf-8");
  }
  return docs;
}

// ─── MIME body decoder ─────────────────────────────────────

function decodeMimeBody(rawBody) {
  if (!rawBody) return "";

  // Check if it's a MIME multi-part message
  const boundaryMatch = rawBody.match(/boundary="?([^"\r\n]+)"?/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawBody.split("--" + boundary);
    for (const part of parts) {
      // Find the text/plain part
      if (part.includes('Content-Type: text/plain')) {
        // Extract body after headers
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        let content = part.substring(headerEnd + 4);

        // Check for Content-Transfer-Encoding: base64
        if (part.includes('Content-Transfer-Encoding: base64')) {
          try {
            content = Buffer.from(content.trim(), "base64").toString("utf-8");
          } catch (_) {
            // keep as-is
          }
        }
        return content.trim();
      }
    }
    // Fallback: return first part after stripping MIME headers
    if (parts.length > 1) {
      const lastPart = parts[parts.length - 1];
      const headerEnd = lastPart.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const content = lastPart.substring(headerEnd + 4);
        // Try base64 decode
        if (lastPart.includes("base64")) {
          try {
            return Buffer.from(content.trim(), "base64").toString("utf-8");
          } catch (_) {}
        }
        return content.trim();
      }
    }
  }

  // Try direct base64 decode for non-MIME bodies
  const cleaned = rawBody.trim().replace(/\s/g, "");
  if (/^[A-Za-z0-9+/=]{40,}$/.test(cleaned)) {
    try {
      return Buffer.from(cleaned, "base64").toString("utf-8");
    } catch (_) {}
  }

  return rawBody.substring(0, 5000);
}

// ─── Intent classification (keyword-based, runs without Claude) ──

const INTERESTED_ZH = [
  "价格", "多少钱", "报价", "产品", "发货", "物流", "样品",
  "感兴趣", "了解", "演示", "联系", "电话", "采购", "合作",
  "规格", "参数", "资料", "目录", "MOQ", "交期", "定制",
];

const INTERESTED_EN = [
  "price", "pricing", "cost", "quote", "demo", "sample",
  "interested", "tell me more", "learn more", "shipping",
  "delivery", "catalog", "spec", "specification", "MOQ",
  "lead time", "custom", "OEM", "ODM", "call", "meeting",
  "trial", "order", "buy", "purchase", "more info",
];

const NOT_INTERESTED_ZH = [
  "不需要", "不感兴趣", "不用了", "暂时不需要", "以后再说",
  "退订", "取消订阅", "发错了", "不是", "勿回复",
];

const NOT_INTERESTED_EN = [
  "not interested", "no thanks", "unsubscribe", "remove",
  "wrong person", "not now", "maybe later", "don't contact",
  "stop", "do not email", "out of office", "vacation",
];

function classifyIntent(body, subject) {
  const text = (body + " " + subject).toLowerCase();

  // Check not-interested first (stronger signal)
  for (const kw of NOT_INTERESTED_ZH) {
    if (text.includes(kw)) return { intent: "not_interested", reason: `Keyword match: "${kw}"` };
  }
  for (const kw of NOT_INTERESTED_EN) {
    if (text.includes(kw)) return { intent: "not_interested", reason: `Keyword match: "${kw}"` };
  }

  // Check auto-reply / OOO
  if (
    text.includes("out of office") ||
    text.includes("auto-reply") ||
    text.includes("autoreply") ||
    text.includes("自动回复") ||
    text.includes("休假")
  ) {
    return { intent: "not_interested", reason: "Auto-reply/out-of-office detected" };
  }

  // Check interested
  for (const kw of INTERESTED_ZH) {
    if (text.includes(kw)) return { intent: "interested", reason: `Keyword match: "${kw}"` };
  }
  for (const kw of INTERESTED_EN) {
    if (text.includes(kw)) return { intent: "interested", reason: `Keyword match: "${kw}"` };
  }

  // Default: ask a question → interested; otherwise neutral → unknown
  if (text.includes("?")) {
    return { intent: "interested", reason: "Contains a question (likely interested)" };
  }

  return { intent: "unknown", reason: "No strong signal detected" };
}

// ─── Generate auto-reply (template-based, no Claude) ──────

function generateAutoReply(contact, replyBody, intentReason, kbDocs, language) {
  const isZh = language === "zh";
  const name = contact.name || "there";

  // Extract key topic from reply
  let topic = "your inquiry";
  for (const kw of ["price", "pricing", "价格", "多少钱"]) {
    if (replyBody.toLowerCase().includes(kw)) { topic = "pricing"; break; }
  }
  for (const kw of ["shipping", "delivery", "物流", "发货"]) {
    if (replyBody.toLowerCase().includes(kw)) { topic = "shipping and delivery"; break; }
  }
  for (const kw of ["product", "产品", "spec", "catalog"]) {
    if (replyBody.toLowerCase().includes(kw)) { topic = "our product lineup"; break; }
  }

  let reply;
  if (isZh) {
    reply = `您好 ${name}，

感谢您的回复！关于${topic === "pricing" ? "价格" : topic === "shipping and delivery" ? "物流发货" : topic === "our product lineup" ? "产品" : "您的问题"}，我们已收到。

我们的销售团队将在 24 小时内与您联系，为您提供详细信息。如果您有紧急需求，请直接回复此邮件。

祝商祺
729855417@qq.com`;
  } else {
    reply = `Hi ${name},

Thank you for your reply! We've received your inquiry regarding ${topic}.

Our sales team will follow up with you within 24 hours with detailed information tailored to your needs. In the meantime, if you have any urgent questions, feel free to reply to this email directly.

Best regards,
729855417@qq.com`;
  }

  return reply;
}

// ─── Database helpers ─────────────────────────────────────

let db;

async function openDb() {
  const SQL = await initSqlJs();
  return new SQL.Database(fs.readFileSync(DB_PATH));
}

function saveDb(database) {
  fs.writeFileSync(DB_PATH, Buffer.from(database.export()));
}

function dbGet(database, sql, params = []) {
  const stmt = database.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function dbRun(database, sql, params = []) {
  database.run(sql, params);
}

function messageIdExists(database, messageId) {
  if (!messageId) return false;
  const rows = dbGet(database,
    "SELECT id FROM email_log WHERE message_id = ? LIMIT 1",
    [messageId]
  );
  return rows.length > 0;
}

const TERMINAL_STATES = ["HANDED_OVER", "NOT_INTERESTED", "EXITED"];

function isTerminalState(database, contactId) {
  const rows = dbGet(database,
    "SELECT state FROM workflow_state WHERE contact_id = ?",
    [contactId]
  );
  if (rows.length === 0) return false;
  return TERMINAL_STATES.includes(rows[0].state);
}

// ─── Core: Check for and process replies ──────────────────

async function checkAndProcess(log) {
  requireDeps();
  const crmSettings = loadJson(CRM_SETTINGS_PATH);
  const emailConfig = loadJson(EMAIL_CONFIG_PATH);
  const kbDocs = loadKbDocs();
  const pollingConfig = crmSettings.autoReplyPolling || {};
  const language = crmSettings.language || "en";
  const autoApprove = crmSettings.autoApproveDrafts === true;

  // Use lastCheckedAt for incremental polling; fall back to replyCheckDays for first run
  const sinceDate = pollingConfig.lastCheckedAt
    ? new Date(pollingConfig.lastCheckedAt)
    : (() => { const d = new Date(); d.setDate(d.getDate() - (emailConfig.replyCheckDays || 7)); return d; })();

  log(`   Checking since: ${sinceDate.toISOString()}`);

  // Update lastCheckedAt BEFORE processing to avoid re-fetching same messages on error
  pollingConfig.lastCheckedAt = new Date().toISOString();
  crmSettings.autoReplyPolling = pollingConfig;
  fs.writeFileSync(CRM_SETTINGS_PATH, JSON.stringify(crmSettings, null, 2));

  // ── Poll IMAP ─────────────────────────────────────────
  const client = new ImapFlow({
    host: emailConfig.imap.host,
    port: emailConfig.imap.port,
    secure: emailConfig.imap.secure,
    auth: { user: emailConfig.imap.auth.user, pass: emailConfig.imap.auth.pass },
    logger: false,
  });

  let messages = [];
  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    for await (const msg of client.fetch(
      { unseen: true },
      { uid: true, envelope: true, headers: true, bodyParts: ["text"] },
      { uid: true }
    )) {
      const envelope = msg.envelope || {};
      const msgDate = envelope.date ? new Date(envelope.date) : null;
      if (msgDate && msgDate < sinceDate) continue;

      let bodyText = "";
      if (msg.bodyParts) {
        const textPart = msg.bodyParts.get("text");
        if (textPart) bodyText = textPart.toString();
      }

      const rawHeaders = msg.headers || [];
      const headersObj = {};
      for (const h of rawHeaders) {
        headersObj[h.key?.toLowerCase()] = h.value;
      }

      messages.push({
        from: envelope.from?.[0]?.addr || "unknown",
        fromFull: envelope.from?.[0]
          ? `${envelope.from[0].name || ""} <${envelope.from[0].addr || ""}>`.trim()
          : "unknown",
        subject: envelope.subject || "",
        date: msgDate,
        messageId: envelope.messageId || headersObj["message-id"] || null,
        inReplyTo: envelope.inReplyTo || headersObj["in-reply-to"] || null,
        references: headersObj["references"] || null,
        body: bodyText,
      });
    }
    await client.logout();
  } catch (err) {
    log(`IMAP error: ${err.message}`);
    try { await client.logout(); } catch (_) {}
    return { checked: 0, processed: 0 };
  }

  if (messages.length === 0) {
    log("No new unseen messages.");
    return { checked: 0, processed: 0 };
  }

  log(`Found ${messages.length} new message(s).`);

  // ── Open database ────────────────────────────────────
  const database = await openDb();
  let processed = 0;

  for (const msg of messages) {
    // Match reply to sent email
    const candidates = [];
    if (msg.inReplyTo) candidates.push(msg.inReplyTo.trim());
    if (msg.references) {
      candidates.push(...msg.references.split(/\s+/).map((s) => s.trim()));
    }

    let matchedEmail = null;
    if (candidates.length > 0) {
      const placeholders = candidates.map(() => "?").join(",");
      const rows = dbGet(
        database,
        `SELECT e.id, e.contact_id, e.message_id, c.name, c.email, c.company, ws.state
         FROM email_log e
         JOIN contacts c ON e.contact_id = c.id
         LEFT JOIN workflow_state ws ON c.id = ws.contact_id
         WHERE e.message_id IN (${placeholders}) AND e.direction = 'outbound'
         ORDER BY e.sent_at DESC LIMIT 1`,
        candidates
      );
      if (rows.length > 0) matchedEmail = rows[0];
    }

    // Fallback: match by sender email and subject
    if (!matchedEmail) {
      const normalizedSubject = (msg.subject || "")
        .replace(/^(Re|Fwd|Fw|AW|WG|回复|转发)[\s:：\[\]]+/i, "")
        .trim()
        .toLowerCase();
      const rows = dbGet(
        database,
        `SELECT e.id, e.contact_id, e.message_id, c.name, c.email, c.company, ws.state
         FROM email_log e
         JOIN contacts c ON e.contact_id = c.id
         LEFT JOIN workflow_state ws ON c.id = ws.contact_id
         WHERE LOWER(e.subject) = ? AND e.direction = 'outbound'
         ORDER BY e.sent_at DESC LIMIT 1`,
        [normalizedSubject]
      );
      if (rows.length > 0) matchedEmail = rows[0];
    }

    if (!matchedEmail) {
      log(`  ⚠ Unmatched: ${msg.fromFull} — "${msg.subject?.substring(0, 60)}"`);
      continue;
    }

    const contact = matchedEmail;

    // ── Dedup: skip already-processed messages ──────────
    if (messageIdExists(database, msg.messageId)) {
      log(`  ⏭ Skipped (already processed): ${contact.name} — "${msg.subject?.substring(0, 60)}"`);
      continue;
    }

    // ── Terminal state guard ────────────────────────────
    if (isTerminalState(database, contact.contact_id)) {
      log(`  ⏭ Skipped (terminal state: ${contact.state}): ${contact.name}`);
      continue;
    }

    log(`  ✅ Matched: ${contact.name} <${contact.email}> — "${msg.subject?.substring(0, 60)}"`);

    // ── Decode the actual reply body ────────────────────
    const decodedBody = decodeMimeBody(msg.body);
    log(`     Body: "${decodedBody.substring(0, 120)}"`);

    // Record inbound email
    dbRun(
      database,
      `INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
       VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))`,
      [contact.contact_id, msg.messageId, msg.inReplyTo, msg.subject, decodedBody?.substring(0, 5000)]
    );
    const inboundId = dbGet(database, "SELECT last_insert_rowid() as id")[0].id;

    // Log timeline
    dbRun(
      database,
      `INSERT INTO timeline (contact_id, event_type, description, related_email_id)
       VALUES (?, 'reply_received', ?, ?)`,
      [contact.contact_id, `Auto-daemon: reply received — "${decodedBody?.substring(0, 80)}"`, inboundId]
    );

    // Classify intent (using decoded body)
    const classification = classifyIntent(decodedBody, msg.subject);
    dbRun(
      database,
      `UPDATE email_log SET intent = ?, intent_reason = ?, status = 'intent_classified' WHERE id = ?`,
      [classification.intent, classification.reason, inboundId]
    );

    // Update state
    const newState = classification.intent === "interested" ? "INTERESTED" : "NOT_INTERESTED";
    dbRun(
      database,
      `UPDATE workflow_state SET state = ?, last_action = ?, state_entered_at = datetime('now'), updated_at = datetime('now') WHERE contact_id = ?`,
      [
        newState,
        `Auto-daemon: ${classification.intent} — ${classification.reason}`,
        contact.contact_id,
      ]
    );

    // Log intent
    dbRun(
      database,
      `INSERT INTO timeline (contact_id, event_type, description, related_email_id)
       VALUES (?, 'intent_analyzed', ?, ?)`,
      [contact.contact_id, `Auto-daemon: intent=${classification.intent}. ${classification.reason}`, inboundId]
    );

    log(`     Intent: ${classification.intent} (${classification.reason})`);

    // ── Auto-reply if interested + autoApprove on ─────
    if (classification.intent === "interested" && autoApprove) {
      const replyBody = generateAutoReply(contact, decodedBody, classification.reason, kbDocs, language);
      const replyMsgId = `<${contact.contact_id}.${Date.now()}.auto@crm-outreach>`;

      // Send via SMTP
      const transporter = nodemailer.createTransport({
        host: emailConfig.smtp.host,
        port: emailConfig.smtp.port,
        secure: emailConfig.smtp.secure,
        auth: { user: emailConfig.smtp.auth.user, pass: emailConfig.smtp.auth.pass },
      });

      try {
        await transporter.sendMail({
          from: emailConfig.defaultFrom,
          to: contact.email,
          subject: `Re: ${matchedEmail.subject || msg.subject}`,
          text: replyBody,
          messageId: replyMsgId,
          inReplyTo: msg.messageId,
          references: msg.messageId,
        });

        // Record auto-reply
        dbRun(
          database,
          `INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, sent_at, kb_doc_used)
           VALUES (?, 'outbound', ?, ?, ?, ?, 'handed_over', datetime('now'), ?)`,
          [
            contact.contact_id,
            replyMsgId,
            msg.messageId,
            `Re: ${msg.subject}`,
            replyBody,
            "auto-daemon",
          ]
        );
        const autoReplyId = dbGet(database, "SELECT last_insert_rowid() as id")[0].id;

        // Update state to HANDED_OVER
        dbRun(
          database,
          `UPDATE workflow_state SET state = 'HANDED_OVER', last_action = 'Auto-daemon: auto-reply sent',
           state_entered_at = datetime('now'), updated_at = datetime('now') WHERE contact_id = ?`,
          [contact.contact_id]
        );

        // Log
        dbRun(
          database,
          `INSERT INTO timeline (contact_id, event_type, description, related_email_id)
           VALUES (?, 'handed_over', ?, ?)`,
          [
            contact.contact_id,
            "Auto-daemon: auto-reply sent. REMINDER: Human follow-up needed.",
            autoReplyId,
          ]
        );

        log(`     📤 Auto-reply SENT to ${contact.email}`);
      } catch (err) {
        log(`     ❌ Auto-reply FAILED: ${err.message}`);
        dbRun(
          database,
          `INSERT INTO timeline (contact_id, event_type, description)
           VALUES (?, 'error', ?)`,
          [contact.contact_id, `Auto-daemon: auto-reply failed — ${err.message}`]
        );
      }
    } else if (classification.intent === "interested" && !autoApprove) {
      log(`     ⏸ Auto-reply SKIPPED (autoApproveDrafts is OFF) — pending human review`);
    }

    processed++;
    saveDb(database);
  }

  database.close();
  return { checked: messages.length, processed };
}

// ─── Main loop ────────────────────────────────────────────

async function main() {
  const once = process.argv.includes("--once");
  const crmSettings = loadJson(CRM_SETTINGS_PATH);
  const pollingConfig = crmSettings.autoReplyPolling || {};
  const intervalMs = (pollingConfig.intervalMinutes || 10) * 60 * 1000;

  const timestamp = () => new Date().toISOString().replace("T", " ").substring(0, 19);
  const log = (msg) => console.log(`[${timestamp()}] ${msg}`);

  log("🚀 Auto-Reply Daemon started");
  log(`   Poll interval: ${pollingConfig.intervalMinutes || 10} min`);
  log(`   Auto-approve: ${crmSettings.autoApproveDrafts ? "ON ⚡" : "OFF 🔍"}`);
  log(`   Language: ${crmSettings.language || "en"}`);
  log(`   Database: ${DB_PATH}`);

  if (once) {
    log("   Mode: --once (single check)");
  }

  // Run check loop
  async function tick() {
    try {
      log("🔍 Checking inbox...");
      const result = await checkAndProcess(log);
      log(`✅ Done — ${result.checked} messages, ${result.processed} processed`);
    } catch (err) {
      log(`❌ Error: ${err.message}`);
    }
  }

  await tick();

  if (!once) {
    log(`⏳ Next check in ${pollingConfig.intervalMinutes || 10} minutes...`);
    setInterval(tick, intervalMs);
  } else {
    log("Exiting (--once mode).");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
