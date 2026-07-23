# AI 名片邮件跟进系统 (Mini-CRM)

基于 **Claude Code** 的轻量级 AI 邮件外展系统。无需 Web 服务器、无需数据库服务器、无需独立应用。通过 **MCP Server（后端）+ Skill（前端）** 架构，完全在 Claude Code 客户端内运行。

## 功能概览

1. **名片输入与去重** — 输入客户邮箱、姓名、公司，自动查重防止重复发送
2. **AI 生成个性化邮件** — 结合知识库文档，分析客户画像生成定制化开发信
3. **一键发送** — 通过 QQ 邮箱 SMTP 发送（默认需人工审核草稿）
4. **回复监控** — 手动或自动检查 QQ 邮箱收件箱，匹配客户回复
5. **AI 意图分类** — 智能判断客户意向（有意向 / 无意向 / 自动回复）
6. **自动回复** — 对有意向客户基于知识库生成回复，客服审核后发送
7. **团队转交** — AI 生成对话摘要，一键转交给销售/物流/支持团队
8. **去重保护** — 同一邮箱不会重复发送，已发过的直接提醒

## 架构总览

```
Claude Code 客户端
  ├── /card-followup (Skill)          ← 交互式工作流编排
  ├── SQLite MCP (官方)               ← 联系人、邮件、状态机、审计日志
  ├── Email MCP (自建 ~200 行)        ← SMTP 发送 + IMAP 接收
  └── Filesystem MCP (官方)           ← 知识库文档检索
```

### 状态机

```
NEW → EMAIL_SENT → INTERESTED → HANDED_OVER（人工跟进发货/物流）
                 → NOT_INTERESTED（结束）
```

## 环境要求

- **Node.js** 18+
- **QQ 邮箱** 开启 SMTP/IMAP：
  1. 登录 [QQ 邮箱](https://mail.qq.com)
  2. 设置 → 账户 → 开启 "POP3/SMTP 服务" 和 "IMAP/SMTP 服务"
  3. 获取 **授权码**（不是 QQ 密码）
- **Claude Code** 已安装

## 快速开始

### 1. 安装依赖

```bash
# Email MCP Server 依赖
cd scripts/email-mcp-server && npm install

# 项目根依赖（Daemon 用）
cd ../.. && npm install
```

### 2. 配置邮箱

```bash
cp scripts/email-mcp-server/config.example.json scripts/email-mcp-server/config.json
```

编辑 `scripts/email-mcp-server/config.json`，填入你的 QQ 邮箱和授权码。

### 3. 填写知识库

编辑 `references/knowledge-base/` 下的 4 个模板文件，填入实际的公司、产品、定价、物流信息。

### 4. 初始化数据库

在 Claude Code 中运行 `/card-followup`，选择 "Setup/verify system"。

### 5. 验证连通性

系统会自动检测 SMTP 和 IMAP 连接状态。

## 使用指南

### 主菜单操作

在 Claude Code 中运行 `/card-followup`，主菜单会显示当前系统状态：

```
🔍 Auto-approve OFF | 🌐 EN | ⏸ Auto-polling OFF
```

| 操作 | 说明 |
|------|------|
| 📥 Input new business card | 输入新名片 → 去重 → AI 生成开发信 → 审核发送 |
| 📨 Check for new replies | 检查收件箱 → 匹配客户 → 分类意向 → 自动回复 |
| 🔍 View / Handoff contacts | 查看客户状态和对话历史 / 转交给团队成员 |
| ⚙️ Settings & toggles | 开关设置：自动审批、语言、自动轮询、系统验证 |

### 开关说明

主菜单的三个开关控制系统的自动化程度：

| 开关 | 关闭 | 开启 |
|------|------|------|
| **Auto-approve** | 🔍 草稿需人工审核 | ⚡ 直接发送，跳过审核 |
| **Language** | 🌐 EN 英文 | 🌐 中文 |
| **Auto-polling** | ⏸ 手动检查回复 | 🔄 每 10 分钟自动检查 |

### 自动化程度组合

| Auto-polling | Auto-approve | 行为 |
|-------------|-------------|------|
| OFF | OFF | **纯手动** — 你运行检查，你审核草稿（默认） |
| ON | OFF | **半自动** — 自动检查 + 分类，草稿等你审核 |
| ON | ON | **全自动** — 检查 → 分类 → AI 生成回复 → 自动发送 |

## 自动回复监控（三层策略）

### 策略 A — 手动检查
运行 `/card-followup` → "Check for new replies"。适合调试和低频使用。

### 策略 B — CronCreate 定时唤醒（Claude Code 内）
通过主菜单开启 "🔄 Enable auto-polling"，系统使用 `CronCreate` 每 10 分钟自动触发检查。Claude Code 需保持运行。

### 策略 C — 外部守护进程（7×24）
```bash
# 单次检查（测试）
node scripts/auto-reply-daemon.js --once

# 持续运行（每 N 分钟轮询，间隔在 crm-settings.json 配置）
node scripts/auto-reply-daemon.js
```
独立于 Claude Code 运行，系统开机即可后台工作。使用关键词匹配做意图分类，精度不如 Claude AI，但能 7×24 工作。

## 团队转交功能

当客户聊得差不多了，可以一键转交给团队成员：

1. `/card-followup` → "View / Handoff contacts" → "Handoff prospect"
2. AI 自动生成**对话摘要**（含时间线、关键讨论点、客户意向、待办事项）
3. 选择转交对象（Sales / Logistics / Support，可在 `crm-settings.json` 配置）
4. 填写交接指示
5. 可选：发送通知邮件给团队成员（含完整对话上下文）

转交记录保存在 `handoffs` 表中，状态可追踪（pending → notified → accepted → completed）。

## 邮件引文

所有自动回复邮件都会**附带原始邮件引文**（`> ` 前缀），确保收件人知道这是回复的哪封邮件。

## 项目结构

```
e:/FQH/work/demos/
├── .claude/
│   ├── settings.json                  # 权限预授权
│   └── skills/card-followup/
│       └── SKILL.md                   # 核心 Skill（6 阶段 + 转交）
├── .mcp.json                          # MCP Server 配置
├── data/
│   └── crm.db                         # SQLite 数据库（5 张表）
├── references/
│   ├── crm-settings.json              # 系统设置（语言、审批、轮询、团队成员）
│   ├── knowledge-base/                # 知识库（Markdown）
│   │   ├── product-intro.md
│   │   ├── pricing.md
│   │   ├── shipping-details.md
│   │   └── faq.md
│   └── templates/                     # 邮件模板
│       ├── cold-outreach.md
│       └── interested-reply.md
├── scripts/
│   ├── email-mcp-server/              # 自定义 Email MCP
│   │   ├── index.js                   # send_email / check_replies / verify_connection
│   │   ├── package.json
│   │   ├── config.example.json
│   │   └── config.json                # (gitignored)
│   ├── auto-reply-daemon.js           # 7×24 自动回复守护进程
│   └── setup-db.js                    # 数据库建表参考
├── state-diagram.md                   # 状态机可视化
├── CLAUDE.md                          # 项目上下文
├── .gitignore
└── README.md
```

## 数据库表

| 表 | 说明 |
|----|------|
| `contacts` | 联系人（email UNIQUE 去重） |
| `email_log` | 邮件记录（含 Message-ID 线程匹配） |
| `workflow_state` | 状态机持久化 |
| `timeline` | 审计日志（所有操作可追溯） |
| `handoffs` | 团队转交记录 |

## 核心设计决策

| 决策 | 理由 |
|------|------|
| **SQLite** | 零配置、单文件、官方 MCP 支持 |
| **IMAP 轮询** | 适用任何邮箱（QQ/Gmail/企业邮） |
| **Markdown 知识库** | 简单可版本控制，文档 < 10 篇时优于向量库 |
| **人工审核发件** | 默认所有外发邮件需审核，防止 AI 误发（可开关） |
| **全量审计日志** | timeline 表记录每一步操作，可追溯可回滚 |
| **自定义 Email MCP** | 凭据不入 shell 历史、不出现在 stdout 中 |

## 配置参考 (`references/crm-settings.json`)

```json
{
  "autoApproveDrafts": false,
  "language": "en",
  "autoReplyPolling": {
    "enabled": false,
    "intervalMinutes": 10,
    "cronJobId": ""
  },
  "teamMembers": [
    { "name": "Sales Team", "email": "sales@company.com", "role": "Product info, pricing, negotiation" },
    { "name": "Logistics Team", "email": "shipping@company.com", "role": "Shipping, delivery, customs" },
    { "name": "Support Team", "email": "support@company.com", "role": "Technical support, after-sales" }
  ]
}
```
