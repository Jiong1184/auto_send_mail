/**
 * Database initialization script for the CRM.
 * Creates all tables in the SQLite database.
 *
 * Usage: This script is designed to be called by the Skill via
 * the SQLite MCP server's create_table tool. It can also be
 * run to print the SQL statements for manual execution.
 */

const CREATE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS contacts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL UNIQUE,
      name       TEXT,
      company    TEXT,
      title      TEXT,
      phone      TEXT,
      notes      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS email_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id    INTEGER NOT NULL REFERENCES contacts(id),
      direction     TEXT NOT NULL CHECK(direction IN ('outbound','inbound')),
      status        TEXT NOT NULL DEFAULT 'draft'
                    CHECK(status IN ('draft','queued','sent','failed','received',
                                     'intent_classified','replied_auto','handed_over',
                                     'exited','ignored')),
      message_id    TEXT,
      in_reply_to   TEXT,
      subject       TEXT,
      body          TEXT,
      intent        TEXT CHECK(intent IN ('interested','not_interested','unknown')),
      intent_reason TEXT,
      kb_doc_used   TEXT,
      sent_at       TEXT,
      received_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS workflow_state (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id       INTEGER NOT NULL UNIQUE REFERENCES contacts(id),
      state            TEXT NOT NULL DEFAULT 'NEW'
                       CHECK(state IN ('NEW','EMAIL_SENT','INTERESTED',
                                       'NOT_INTERESTED','HANDED_OVER','EXITED','ERROR')),
      state_entered_at TEXT NOT NULL DEFAULT (datetime('now')),
      retry_count      INTEGER NOT NULL DEFAULT 0,
      last_action      TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS timeline (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id       INTEGER NOT NULL REFERENCES contacts(id),
      event_type       TEXT NOT NULL,
      description      TEXT NOT NULL,
      related_email_id INTEGER REFERENCES email_log(id),
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
];

// Print SQL for use with SQLite MCP server's create_table tool
console.log('-- Database Schema for CRM');
console.log('-- Run these statements via mcp__sqlite__write_query or create_table');
console.log('');
CREATE_TABLES_SQL.forEach((sql, i) => {
  console.log(`-- Table ${i + 1}`);
  console.log(sql);
  console.log('');
});

console.log('-- All tables created successfully.');
