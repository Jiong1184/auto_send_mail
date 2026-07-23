/**
 * Email MCP Server — Custom MCP server for sending/receiving emails.
 *
 * Tools exposed:
 *   - send_email: Send an email via SMTP
 *   - check_replies: Poll IMAP inbox for unseen replies
 *   - verify_connection: Test SMTP + IMAP connectivity
 *
 * Transport: stdio (standard MCP protocol)
 * Config: reads SMTP/IMAP credentials from config.json (gitignored)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

// ─── Config Loading ───────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "config.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(
      `ERROR: config.json not found at ${CONFIG_PATH}. ` +
        `Copy config.example.json to config.json and fill in your QQ Mail credentials.`
    );
    process.exit(1);
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

const config = loadConfig();

// ─── SMTP Transporter ─────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: {
    user: config.smtp.auth.user,
    pass: config.smtp.auth.pass,
  },
});

// ─── Helpers ───────────────────────────────────────────────

function generateMessageId() {
  const domain = config.smtp.auth.user.split("@")[1] || "mail.local";
  return `<${randomUUID()}@${domain}>`;
}

/**
 * Match reply candidates by In-Reply-To and References headers.
 */
function extractHeader(headers, name) {
  // headers is an array of {key, value} from imapflow
  const found = headers.find(
    (h) => h.key?.toLowerCase() === name.toLowerCase()
  );
  return found?.value || null;
}

function normalizeSubject(subject) {
  return (subject || "")
    .replace(/^(Re|Fwd|Fw|AW|WG|答复|转发)[\s:：\[\]]+/i, "")
    .replace(/[\s:：\[\]]+$/, "")
    .trim();
}

// ─── Tool: send_email ─────────────────────────────────────

async function sendEmail(args) {
  const { to, subject, body, messageId, inReplyTo } = args;

  if (!to || !subject || !body) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Missing required fields: to, subject, body",
          }),
        },
      ],
    };
  }

  const msgId = messageId || generateMessageId();

  try {
    const info = await transporter.sendMail({
      from: config.defaultFrom,
      to,
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
      messageId: msgId,
      ...(inReplyTo && {
        inReplyTo,
        references: inReplyTo,
      }),
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            messageId: msgId,
            response: info.response,
            accepted: info.accepted,
            rejected: info.rejected,
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `SMTP send failed: ${err.message}`,
          }),
        },
      ],
    };
  }
}

// ─── Tool: check_replies ──────────────────────────────────

async function checkReplies(args) {
  const { since, unseenOnly, days } = args || {};
  // unseenOnly defaults to true — only fetch unseen (unread) messages by default.
  // Set unseenOnly: false to fetch ALL messages (read + unread), e.g. when
  // a human may have marked messages as read in the webmail UI.
  // The CRM database deduplicates by Message-ID regardless.
  const onlyUnseen = unseenOnly !== false;
  const lookbackDays = days || config.replyCheckDays || 7;

  let sinceDate;
  if (since) {
    sinceDate = new Date(since);
  } else {
    sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - lookbackDays);
  }

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: {
      user: config.imap.auth.user,
      pass: config.imap.auth.pass,
    },
    logger: false,
  });

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX");

    // Search for messages since the given date (unseen only by default;
    // set unseenOnly:false to include read messages)
    const sinceFormatted = sinceDate.toISOString().split("T")[0];
    const messages = [];

    const searchCriteria = onlyUnseen ? { unseen: true } : { all: true };
    for await (const msg of client.fetch(
      searchCriteria,
      {
        uid: true,
        envelope: true,
        bodyStructure: true,
        headers: true,
        bodyParts: ["text"],
      },
      { uid: true }
    )) {
      const envelope = msg.envelope || {};
      const msgDate = envelope.date ? new Date(envelope.date) : null;

      // Filter by date client-side (more flexible than server SEARCH)
      if (msgDate && msgDate < sinceDate) continue;

      // Extract body text
      let bodyText = "";
      if (msg.bodyParts) {
        const textPart = msg.bodyParts.get("text");
        if (textPart) {
          bodyText = textPart.toString();
        }
      }

      // Extract key headers
      const rawHeaders = msg.headers || [];
      const headersObj = {};
      for (const h of rawHeaders) {
        headersObj[h.key?.toLowerCase()] = h.value;
      }

      messages.push({
        from: envelope.from?.[0]
          ? `${envelope.from[0].name || ""} <${envelope.from[0].addr || ""}>`.trim()
          : "unknown",
        to: envelope.to?.[0]?.addr || "unknown",
        subject: envelope.subject || "",
        date: msgDate ? msgDate.toISOString() : null,
        messageId: envelope.messageId || headersObj["message-id"] || null,
        inReplyTo: envelope.inReplyTo || headersObj["in-reply-to"] || null,
        references: headersObj["references"] || null,
        body: bodyText.substring(0, 5000), // limit to 5000 chars
      });
    }

    await client.logout();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            count: messages.length,
            checkedSince: sinceDate.toISOString(),
            messages,
          }),
        },
      ],
    };
  } catch (err) {
    try {
      await client.logout();
    } catch (_) {
      /* ignore */
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `IMAP check failed: ${err.message}`,
          }),
        },
      ],
    };
  }
}

// ─── Tool: verify_connection ──────────────────────────────

async function verifyConnection() {
  const results = { smtp: null, imap: null };

  // Test SMTP
  try {
    await transporter.verify();
    results.smtp = { success: true, message: "SMTP connection verified" };
  } catch (err) {
    results.smtp = { success: false, error: err.message };
  }

  // Test IMAP
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: {
      user: config.imap.auth.user,
      pass: config.imap.auth.pass,
    },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    await client.logout();
    results.imap = { success: true, message: "IMAP connection verified" };
  } catch (err) {
    results.imap = { success: false, error: err.message };
    try {
      await client.logout();
    } catch (_) {
      /* ignore */
    }
  }

  const allOk = results.smtp?.success && results.imap?.success;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: allOk,
          smtp: results.smtp,
          imap: results.imap,
        }),
      },
    ],
  };
}

// ─── MCP Server Setup ─────────────────────────────────────

const server = new Server(
  {
    name: "email-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_email",
      description:
        "Send an email via SMTP. Requires to, subject, and body. " +
        "Optionally accepts messageId and inReplyTo for threading.",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Recipient email address",
          },
          subject: {
            type: "string",
            description: "Email subject line",
          },
          body: {
            type: "string",
            description: "Plain text email body",
          },
          messageId: {
            type: "string",
            description:
              "Optional custom Message-ID. Generated automatically if not provided.",
          },
          inReplyTo: {
            type: "string",
            description:
              "Optional In-Reply-To header. Set to the Message-ID of the email being replied to.",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "check_replies",
      description:
        "Check IMAP inbox for replies. Returns messages with Message-ID, In-Reply-To, and References headers for thread matching. By default fetches only UNSEEN (unread) messages — set unseenOnly:false to read all messages.",
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description:
              "ISO date string. Only return messages received after this date. " +
              "Overrides days and replyCheckDays config.",
          },
          days: {
            type: "number",
            description:
              "Lookback window in days. Defaults to replyCheckDays from config.json (7 days). " +
              "Example: days:30 fetches messages from the last 30 days. Ignored if 'since' is set.",
          },
          unseenOnly: {
            type: "boolean",
            description:
              "If true (default), only fetch unseen/unread messages. " +
              "Set to false to fetch ALL messages including read ones — useful when a human " +
              "may have opened emails in the webmail UI, marking them as read.",
          },
        },
      },
    },
    {
      name: "verify_connection",
      description:
        "Test both SMTP and IMAP connections. Returns success/failure for each.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "send_email":
      return sendEmail(args);
    case "check_replies":
      return checkReplies(args);
    case "verify_connection":
      return verifyConnection();
    default:
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
          },
        ],
      };
  }
});

// ─── Start Server ─────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting email-mcp-server:", err.message);
  process.exit(1);
});
