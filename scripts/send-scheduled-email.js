/**
 * Send a scheduled email at its appointed time.
 *
 * Usage: node scripts/send-scheduled-email.js <email_log_id>
 *
 * Reads the email from the database, calculates the delay until scheduled_at,
 * waits, then sends via SMTP and updates the database. This is a one-shot
 * fire-and-forget process — no daemon polling needed.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EMAIL_CONFIG_PATH = path.join(ROOT, "scripts", "email-mcp-server", "config.json");
const DB_PATH = path.join(ROOT, "data", "crm.db");

const emailLogId = parseInt(process.argv[2], 10);
if (!emailLogId || isNaN(emailLogId)) {
  console.error("Usage: node scripts/send-scheduled-email.js <email_log_id>");
  process.exit(1);
}

async function main() {
  // ── Load deps ─────────────────────────────────────────
  const initSqlJs = require("sql.js");
  const nodemailer = require("nodemailer");
  const emailConfig = JSON.parse(fs.readFileSync(EMAIL_CONFIG_PATH, "utf-8"));

  // ── Open DB ───────────────────────────────────────────
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function dbRun(sql, params = []) {
    db.run(sql, params);
  }

  function saveDb() {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  }

  // ── Read the scheduled email ──────────────────────────
  const rows = dbGet(
    `SELECT e.id, e.contact_id, e.message_id, e.in_reply_to, e.subject, e.body,
            e.scheduled_at, c.email as to_email, c.name, c.timezone
     FROM email_log e
     JOIN contacts c ON e.contact_id = c.id
     WHERE e.id = ? AND e.status = 'scheduled'`,
    [emailLogId]
  );

  if (rows.length === 0) {
    console.log(`Email #${emailLogId} not found or already sent. Exiting.`);
    db.close();
    process.exit(0);
  }

  const email = rows[0];
  const scheduledTime = new Date(email.scheduled_at + "Z"); // UTC
  const now = new Date();
  const delayMs = scheduledTime.getTime() - now.getTime();

  console.log(
    `📧 Scheduled email #${email.id} to ${email.name} <${email.to_email}>`
  );
  console.log(`   Scheduled for: ${scheduledTime.toISOString()}`);
  console.log(`   Timezone: ${email.timezone || "unknown"}`);

  if (delayMs > 0) {
    const delayMin = Math.round(delayMs / 60000);
    console.log(`   Waiting ${delayMin} minutes (${Math.round(delayMs / 1000)}s)...`);

    // Wait until the scheduled time
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  } else {
    console.log(`   Scheduled time already passed — sending now.`);
  }

  // ── Send via SMTP ─────────────────────────────────────
  const transporter = nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: { user: emailConfig.smtp.auth.user, pass: emailConfig.smtp.auth.pass },
  });

  try {
    await transporter.sendMail({
      from: emailConfig.defaultFrom,
      to: email.to_email,
      subject: email.subject,
      text: email.body,
      messageId: email.message_id,
      ...(email.in_reply_to && {
        inReplyTo: email.in_reply_to,
        references: email.in_reply_to,
      }),
    });

    console.log(`   ✅ Sent successfully at ${new Date().toISOString()}`);

    // ── Update database ────────────────────────────────
    dbRun(
      `UPDATE email_log SET status = 'sent', sent_at = datetime('now'), scheduled_at = NULL WHERE id = ?`,
      [email.id]
    );

    // Update workflow state if still NEW
    const stateRows = dbGet(
      `SELECT state FROM workflow_state WHERE contact_id = ?`,
      [email.contact_id]
    );
    if (stateRows.length > 0 && stateRows[0].state === "NEW") {
      dbRun(
        `UPDATE workflow_state SET state = 'EMAIL_SENT', last_action = 'Scheduled outreach sent',
         state_entered_at = datetime('now'), updated_at = datetime('now') WHERE contact_id = ?`,
        [email.contact_id]
      );
    }

    // Log timeline
    dbRun(
      `INSERT INTO timeline (contact_id, event_type, description, related_email_id)
       VALUES (?, 'email_sent', ?, ?)`,
      [email.contact_id, `Scheduled outreach email sent to ${email.name}`, email.id]
    );

    saveDb();
    console.log(`   📝 Database updated.`);
  } catch (err) {
    console.error(`   ❌ Send failed: ${err.message}`);
    dbRun(
      `INSERT INTO timeline (contact_id, event_type, description)
       VALUES (?, 'error', ?)`,
      [email.contact_id, `Scheduled send failed: ${err.message}`]
    );
    saveDb();
    process.exit(1);
  }

  db.close();
  console.log(`   Done.`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
