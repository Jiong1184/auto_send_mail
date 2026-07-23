# Workflow State Machine

```
                    ┌──────────────────────────┐
                    │          NEW             │
                    │  Contact created,         │
                    │  no email sent yet        │
                    └────────────┬─────────────┘
                                 │
                     [send outreach email]
                     (user approves draft)
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │       EMAIL_SENT         │
                    │  Waiting for prospect     │
                    │  to reply                 │
                    └────────────┬─────────────┘
                                 │
                     [prospect replies]
                     (detected via IMAP poll)
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │    INTENT_CLASSIFIED     │
                    │  AI analyzes reply        │
                    │  (transient state)        │
                    └────┬──────────┬──────────┘
                         │          │
             [interested]│          │[not interested]
                         │          │
                         ▼          ▼
          ┌──────────────────┐  ┌──────────────────┐
          │   INTERESTED     │  │ NOT_INTERESTED   │
          │  Prospect wants  │  │ Declined / OOO / │
          │  to learn more   │  │ wrong person     │
          └────────┬─────────┘  └──────────────────┘
                   │                    → END
      [AI composes auto-reply]
      (user approves)
                   │
                   ▼
          ┌──────────────────┐
          │   HANDED_OVER    │
          │  Auto-reply sent │
          │  ⚠ Human follow-up│
          │  needed for      │
          │  shipping/delivery│
          └──────────────────┘
                   → END
```

## State Descriptions

| State | Description | Next Action |
|-------|-------------|-------------|
| `NEW` | Contact created from business card input | Generate and send outreach email |
| `EMAIL_SENT` | Outreach email sent, awaiting reply | Check inbox for replies |
| `INTENT_CLASSIFIED` | Reply received, AI analyzed intent (transient) | Route to INTERESTED or NOT_INTERESTED |
| `INTERESTED` | Prospect showed interest | Generate auto-reply based on KB |
| `NOT_INTERESTED` | Prospect declined or OOO | End of workflow |
| `HANDED_OVER` | Auto-reply sent, ready for human | Human follows up on shipping/delivery |
| `EXITED` | Manually exited from pipeline | End of workflow |
| `ERROR` | An error occurred (SMTP failure, etc.) | Retry or manual intervention |

## Event Types (timeline)

| Event | Trigger |
|-------|---------|
| `card_input` | New business card entered |
| `email_sent` | Outreach email successfully sent |
| `reply_received` | Inbound reply matched to contact |
| `intent_analyzed` | AI classified reply as interested/not_interested |
| `auto_replied` | Auto-reply sent (not yet in HANDED_OVER) |
| `handed_over` | Final auto-reply sent, human follow-up needed |
| `exited` | Contact manually removed from pipeline |
| `error` | Error occurred |
| `note` | Manual note added by user |
