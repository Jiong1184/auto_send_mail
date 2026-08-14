#!/usr/bin/env node
/**
 * CRM IMAP IDLE Daemon — event-driven replacement for time-based auto-reply polling.
 *
 * Holds a persistent IMAP IDLE connection to QQ Exmail. When the server pushes a
 * new-mail notification (`exists` event), debounces a short window (to batch several
 * mails arriving in quick succession), then spawns `scripts/auto-check.sh`, which runs
 * the existing headless `claude -p` auto-reply pipeline (flock-guarded, so overlapping
 * invocations are skipped safely).
 *
 * Runs one catch-up check on every (re)connect so mail that arrived while the daemon
 * was offline is not missed — IDLE only notifies about messages that arrive *after*
 * the connection is established.
 *
 * imapflow does NOT auto-reconnect (per its docs), so this script owns the reconnect
 * loop with exponential backoff.
 *
 * Config:
 *   - scripts/email-mcp-server/config.json  → IMAP credentials (same file the MCP server uses)
 *   - references/crm-settings.json          → idleDaemon.debounceSeconds (default 60)
 * Logs to data/idle-daemon.log.
 *
 * Linux target (systemd unit: deploy/crm-idle-daemon.service).
 */

import { ImapFlow } from "imapflow";
import { spawn } from "child_process";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = __dirname; // scripts/email-mcp-server
const PROJECT_DIR = resolve(SERVER_DIR, "..", ".."); // project root
const CONFIG_PATH = resolve(SERVER_DIR, "config.json");
const SETTINGS_PATH = resolve(PROJECT_DIR, "references", "crm-settings.json");
const DATA_DIR = resolve(PROJECT_DIR, "data");
const LOG_FILE = resolve(DATA_DIR, "idle-daemon.log");
const AUTO_CHECK = resolve(PROJECT_DIR, "scripts", "auto-check.sh");

const BACKOFF_START_MS = 5 * 1000;
const BACKOFF_MAX_MS = 60 * 1000;
// imapflow re-issues IDLE every maxIdleTime ms — keeps the connection alive past the
// server-side idle timeout (~30 min on QQ Exmail) without a full reconnect.
const MAX_IDLE_MS = 29 * 60 * 1000;
const DEFAULT_DEBOUNCE_SECONDS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Logging ───────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {
    // A log write must never crash the daemon.
  }
  console.log(line);
}

// ─── Config ────────────────────────────────────────────────

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    log(
      `ERROR: config.json not found at ${CONFIG_PATH}. ` +
        `Copy config.example.json → config.json and fill in IMAP credentials.`
    );
    process.exit(1);
  }
  return loadJson(CONFIG_PATH);
}

function loadSettings() {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return loadJson(SETTINGS_PATH).idleDaemon || {};
  } catch (err) {
    log(`WARN: could not read ${SETTINGS_PATH} (${err.message}); using defaults.`);
    return {};
  }
}

const config = loadConfig();
const settings = loadSettings();
const DEBOUNCE_MS = (settings.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS) * 1000;

// ─── Trigger action: run one auto-check ────────────────────

let running = false; // guard vs. spawning while a check is in flight (auto-check.sh flock also protects)
let debounceTimer = null;

function triggerCheck(reason) {
  if (running) {
    // The in-flight check polls ALL unseen mail, so anything new will be picked up anyway.
    log(`[trigger] ${reason} — a check is already running; skipping spawn (flock guards overlap).`);
    return;
  }
  running = true;
  log(`[trigger] ${reason} → spawning ${AUTO_CHECK}`);
  const child = spawn("bash", [AUTO_CHECK], {
    cwd: PROJECT_DIR,
    detached: true, // let the check finish even if the daemon is restarted
    stdio: "ignore", // auto-check.sh writes its own log (data/auto-check.log)
  });
  child.on("error", (err) => log(`[trigger] spawn failed: ${err.message}`));
  child.on("exit", (code, signal) => {
    log(`[trigger] auto-check.sh exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    running = false;
  });
}

function scheduleCheck(reason) {
  clearTimeout(debounceTimer);
  log(`[idle] new mail (${reason}); scheduling check in ${DEBOUNCE_MS}ms (debounce)`);
  debounceTimer = setTimeout(() => triggerCheck(`debounce fired after ${DEBOUNCE_MS}ms (${reason})`), DEBOUNCE_MS);
}

// ─── Main loop: connect → select INBOX → IDLE → reconnect ──

async function run() {
  let backoff = BACKOFF_START_MS;

  while (true) {
    let listening = false; // ignore the initial EXISTS the server sends during SELECT
    const client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      auth: {
        user: config.imap.auth.user,
        pass: config.imap.auth.pass,
      },
      logger: false,
      maxIdleTime: MAX_IDLE_MS,
    });

    client.on("exists", () => {
      if (!listening) return; // SELECT's opening EXISTS, not a new arrival
      scheduleCheck("IMAP exists event");
    });
    client.on("error", (err) => log(`[imap] error: ${err.message}`));
    client.on("close", () => log("[imap] connection closed"));

    try {
      await client.connect();
      log(`[imap] connected to ${config.imap.host}:${config.imap.port}`);
      await client.mailboxOpen("INBOX");
      listening = true;
      log("[imap] INBOX selected, entering IDLE");

      // Catch-up: process anything that arrived while we were offline/reconnecting.
      triggerCheck("catch-up on (re)connect");
      backoff = BACKOFF_START_MS; // successful connection → reset backoff

      // Blocks until the IDLE command ends (maxIdleTime reached, server disconnect, or error).
      await client.idle();
      log("[imap] idle() returned (maxIdleTime reached or connection dropped)");
    } catch (err) {
      log(`[imap] error in loop: ${err.message}`);
    } finally {
      try {
        await client.close();
      } catch (_) {
        /* ignore */
      }
    }

    log(`[imap] reconnecting in ${backoff}ms...`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

// ─── Graceful shutdown ─────────────────────────────────────

process.on("SIGINT", () => {
  log("SIGINT received, shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("SIGTERM received, shutting down");
  process.exit(0);
});

log(`CRM IMAP IDLE daemon starting. debounce=${DEBOUNCE_MS}ms, project=${PROJECT_DIR}`);
run().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
