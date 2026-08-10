# IM 集成方案对比与实施计划

## Context

当前 CRM 项目仅支持邮件作为交互通道。部署到服务器后需要与企业微信和飞书交互，实现：
- **入站**：在企微/飞书中发送名片图片 → 自动 OCR → 创建联系人 → 生成 outreach 邮件
- **出站**：新回复通知、handoff 通知、审批请求等推送到企微/飞书

---

## 候选方案对比

### Synapse（`@tk-brother/synapse`）

| 维度 | 数据 |
|------|------|
| GitHub Stars | 未知（仓库存在但无明显社区关注） |
| npm 周下载 | ~64 |
| 版本数 | 4 个版本，全部在 2026-04-18~19 一天内发布 |
| 维护者 | 1 人（k-brother） |
| 技术栈 | Node.js/TypeScript |
| 平台支持 | 飞书、企微、Telegram、钉钉（4 个） |
| 架构模式 | Bridge 模式（接收消息→调 AI→回复）+ MCP Server 模式（Claude Code 主动推送） |
| 公网 IP 需求 | 需要（长连接/WebSocket 回调） |
| License | MIT |

### cc-connect（`npm: cc-connect`）

| 维度 | 数据 |
|------|------|
| GitHub Stars | **~13,400** ⭐ |
| 贡献者 | **140+** |
| npm 周下载 | **~4,636** |
| 版本数 | **43 个**，2026 年保持每周发版节奏 |
| 维护者 | chenhg5 + 活跃社区 |
| 技术栈 | Go（通过 npm/npx 分发预编译二进制） |
| 平台支持 | 飞书、企微、钉钉、Telegram、Slack、Discord、LINE、QQ、个人微信、Webex、Matrix 等 **15+** |
| 架构模式 | Bridge 守护进程 + Agent 适配器（Claude Code 作为 first-class agent） |
| 公网 IP 需求 | **不需要**（WebSocket/Stream 模式，出站连接） |
| 额外功能 | Web 管理后台（v1.3.0+）、生命周期钩子、内置 Cron 定时任务、流式回复、语音 STT/TTS、`/cron` `/new` `/list` `/switch` 等聊天命令 |
| License | MIT |

### 关键差异对比

| 对比维度 | Synapse | cc-connect |
|------|------|------|
| **成熟度** | 🔴 极早期，一天发完所有版本 | 🟢 成熟，43 个版本迭代 4+ 个月 |
| **社区** | 🔴 几乎为零 | 🟢 13.4k star，140+ 贡献者 |
| **维护风险** | 🔴 Bus factor = 1 | 🟢 活跃社区 + 每周发版 |
| **公网 IP** | 🔴 需要 | 🟢 不需要（WebSocket 出站） |
| **MCP 主动推送** | 🟢 内置 MCP Server 模式 | 🟡 无内置 MCP，但可搭配 `cc-lark` MCP Server，或通过 `cc-connect send` CLI |
| **企微图片收发** | 🔴 文档不清 | 🟢 明确支持文件/图片收发 |
| **配置复杂度** | 🟡 环境变量 + JSON 配置 | 🟡 TOML 配置文件 |
| **部署方式** | npm 全局安装 | npm / Homebrew / 二进制 三种方式 |
| **管理界面** | ❌ 无 | 🟢 Web 管理后台 |

### 推荐：cc-connect 为主 + cc-lark 为辅

cc-connect 在成熟度、社区活跃度、公网部署便利性上全面优于 Synapse。对于本项目的两种核心能力：

- **入站（收名片图片 + 审批交互）**→ cc-connect Bridge 模式，用户发消息/图片到飞书/企微 → cc-connect 路由到 Claude Code 处理
- **出站（主动推送通知）**→ cc-connect 自带 `cc-connect send` CLI 命令推送消息；如需更丰富的飞书 API 操作（多维表格、文档、日历），搭配 `cc-lark` MCP Server

---

## 风险分析

### 🟢 cc-connect 项目风险（低）

| 风险 | 严重度 | 详情与缓解 |
|------|:---:|------|
| **Go 技术栈** | 低 | Go 编写，npm 分发预编译二进制。如不兼容服务器架构（如 ARMv7），需自行编译 |
| **配置格式** | 低 | 使用 TOML 配置，与项目现有 JSON 风格不一致，但可接受 |
| **无内置 MCP** | 中 | cc-connect 不是 MCP Server。缓解：`cc-connect send` CLI 通过 Bash 工具调用；深度飞书集成搭配 `cc-lark` MCP Server |

### 🔴 MCP STDIO 安全风险（2026 年 4 月重大披露）

| 风险 | 严重度 | 详情 |
|------|:---:|------|
| **STDIO RCE（设计级漏洞）** | **严重** | MCP SDK 的 `command` 字段不经校验直接传给 OS 进程 spawn。Anthropic 确认为 "by-design"，不会修复 |
| **环境变量泄露** | 高 | STDIO 子进程继承父进程全部环境变量 |
| **无身份验证** | 高 | STDIO 传输层无客户端/服务端身份校验 |
| **Prompt 注入** | 高 | 攻击者可通过 IM 消息注入指令操控 AI 行为 |

> **重要**：cc-connect 本身不使用 MCP STDIO（它是独立守护进程，通过 Agent 适配器调用 Claude Code），所以 STDIO RCE **不直接影响** cc-connect。但 `cc-lark`（如使用）是 MCP Server 走 STDIO，仍需容器化隔离。

**缓解措施**：
- cc-connect + Claude Code 放在 rootless container 中
- 生产环境剥离不必要的宿主环境变量
- 所有破坏性操作（发邮件、改 DB）保留人工审批，不因 IM 来源而自动放行
- cc-connect 内置 `allow_from` 白名单限制可使用的用户
- cc-lark（如使用）单独容器化，只读文件系统

### 🟡 企业 IM 平台安全风险

| 风险 | 严重度 | 详情与缓解 |
|------|:---:|------|
| **企微无签名校验** | 中 | 企微机器人不像飞书有 HMAC 签名。缓解：`allow_from` 白名单 + WebSocket 模式 |
| **Token/Secret 泄露** | 高 | 缓解：凭证仅通过环境变量注入，不入库；定期 90 天轮换 |
| **WebSocket 断连** | 低 | cc-connect 内置自动重连机制 |

### 🟡 业务与合规风险

| 风险 | 严重度 | 详情 |
|------|:---:|------|
| **客户数据流入 IM** | 中 | 名片含客户姓名/公司/邮箱/手机号，通过 IM 传输增加泄露面 |
| **消息可靠性** | 中 | IM 平台不保证 100% 送达，WebSocket 断连可能丢消息 |
| **审计追溯** | 低 | 现有 timeline 表已记录全量操作，IM 消息建议额外记录到 timeline |

---

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                      服务器 (Docker)                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │               cc-connect (Go 守护进程)               │  │
│  │   接收 IM 消息 → 路由到 Claude Code Agent → 回复      │  │
│  └──────────┬─────────────────────────────────────────┘  │
│             │ Agent Adapter (claudecode)                  │
│  ┌──────────▼─────────────────────────────────────────┐  │
│  │              Claude Code (headless)                  │  │
│  │  ┌───────────────────────────────────────────────┐ │  │
│  │  │       MCP Servers (stdio)                      │ │  │
│  │  │  sqlite │ email │ filesystem │ (cc-lark 可选)  │ │  │
│  │  └───────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                                │
│         cc-connect WebSocket/Stream (出站连接)              │
│             无需公网 IP，无需配置回调 URL                     │
│                     ↕          ↕                          │
│               企业微信 API    飞书 API                       │
└──────────────────────────────────────────────────────────┘
```

---

## 实施计划

### Phase 1: 平台准备（手动操作）

1. **飞书开放平台**
   - 创建企业自建应用 → 开启机器人能力
   - 添加权限：`im:message:send_as_bot`、`im:message`、`im:message:patch_as_bot`、`im:resource`
   - 选择 **WebSocket 连接模式**（无需公网 IP）
   - 订阅事件：`im.message.receive_v1`、`card.action.trigger`
   - 发布应用，获取 App ID / App Secret

2. **企业微信管理后台**（可选，第二阶段）
   - 创建自建应用 → 获取 Corp ID、Agent ID、Secret
   - 选择 WebSocket 模式

3. **服务器准备**
   - **不需要公网 IP 或域名**（cc-connect 的核心优势）
   - 只需服务器能出站访问飞书/企微 API

### Phase 2: cc-connect 部署

1. **安装**
   ```bash
   npm install -g cc-connect
   # 或 brew install cc-connect
   # 或下载 GitHub Release 二进制
   ```

2. **创建 `~/.cc-connect/config.toml`**
   ```toml
   [[projects]]
   name = "crm"
   
   [projects.agent]
   type = "claudecode"
   
   [projects.agent.options]
   work_dir = "/app/auto_send_mail"
   mode = "default"
   
   # 飞书
   [[projects.platforms]]
   type = "feishu"
   [projects.platforms.options]
   app_id = "${FEISHU_APP_ID}"
   app_secret = "${FEISHU_APP_SECRET}"
   allow_from = ["ou_xxx"]  # 仅允许团队成员的 open_id
   
   # 企业微信（可选）
   [[projects.platforms]]
   type = "wecom"
   [projects.platforms.options]
   corp_id = "${WECOM_CORP_ID}"
   agent_id = "${WECOM_AGENT_ID}"
   secret = "${WECOM_SECRET}"
   connection_type = "websocket"
   allow_from = ["user1"]
   ```

3. **(可选) 搭配 cc-lark MCP Server** — 用于 Claude Code 主动调用飞书 API

   `.mcp.json` 添加：
   ```json
   {
     "feishu": {
       "command": "npx",
       "args": ["cc-lark"]
     }
   }
   ```
   `.claude/settings.json` 添加权限：`mcp__feishu__send_message`、`mcp__feishu__send_card`、`mcp__feishu__upload_image`

### Phase 3: Skill 改造

文件：`.claude/skills/card-followup/skill.md`（和 `skill-zh.md`）

**出站推送节点**（通过 `cc-connect send` CLI 或 cc-lark MCP）：

| 触发节点 | 推送内容 | 方式 |
|------|------|------|
| Phase 4 检测到新回复 | 「客户 XXX 回复了！」+ 摘要 | `cc-connect send --project crm -m "..."` |
| Phase 5 INTERESTED | 「客户 XXX 有兴趣！」+ 详情 | 同上 |
| Phase 5 NOT_INTERESTED | 简要通知 | 同上 |
| Phase 6 handoff 完成 | Handoff 摘要 + 跟进建议 | 飞书卡片消息（通过 cc-lark） |
| SMTP / 系统异常 | 告警通知 | `cc-connect send` |

**入站名片处理**（cc-connect Bridge 自动路由）：

1. 用户 @机器人 发送名片图片
2. cc-connect 收到 → 路由到 Claude Code Agent
3. OCR → 去重 → 生成 outreach 邮件
4. 草稿推回 IM 审批（飞书卡片带按钮）
5. 「批准」→ 发送邮件；「拒绝」→ 取消

> Skill Phase 2 需增加分支：输入来源为 IM 消息时，走 IM 卡片审批流程而非终端 AskUserQuestion。

### Phase 4: 容器化部署

```yaml
# docker-compose.yml
services:
  cc-connect:
    build: .
    volumes:
      - ~/.cc-connect/config.toml:/app/config.toml:ro
      - ./data:/app/data
    environment:
      - FEISHU_APP_ID=${FEISHU_APP_ID}
      - FEISHU_APP_SECRET=${FEISHU_APP_SECRET}
    restart: unless-stopped
```

### Phase 5: 安全加固

1. **用户白名单**：`allow_from` 限制仅团队成员
2. **容器化**：rootless container + 只读文件系统（`data/` 除外）
3. **环境变量剥离**：清除宿主敏感环境变量再 spawn
4. **审批门控**：破坏性操作保留 IM 卡片按钮审批
5. **审计双记录**：cc-connect 日志 + 现有 timeline 表

---

## 关键文件修改清单

| 文件 | 改动 | 说明 |
|------|:---:|------|
| `~/.cc-connect/config.toml` | **新建** | cc-connect 平台 + Agent 配置 |
| `.mcp.json` | 修改 | (可选) 添加 cc-lark MCP Server |
| `.claude/settings.json` | 修改 | 添加 `Bash(cc-connect:*)`；(可选) 添加 cc-lark MCP 权限 |
| `.claude/skills/card-followup/skill.md` | 修改 | IM 入站图片处理 + 出站推送节点 |
| `.claude/skills/card-followup/skill-zh.md` | 修改 | 同上（中文版） |
| `docker-compose.yml` | **新建** | cc-connect + CRM 容器编排 |
| `Dockerfile` | **新建** | 生产镜像 |
| `references/crm-settings.json` | 修改 | 增加 IM 配置段（平台开关、白名单、通知偏好） |

---

## 验证步骤

1. **飞书连通性**：启动 cc-connect → @机器人发「你好」→ 确认回复
2. **名片入站**：发名片照片 → 确认 OCR → 确认返回联系人信息
3. **审批流程**：回复「批准」→ 确认邮件发出 + DB 状态更新
4. **回复通知**：测试邮箱回复 → 确认飞书收到通知
5. **安全验证**：非白名单用户发消息 → 确认被忽略；发邮件 → 确认触发审批卡片

---

## 分阶段推进建议

- **第一阶段（1-2 天）**：飞书出站通知（`cc-connect send` 推送）+ 邮件入站不变 → 验证稳定性
- **第二阶段（1 周后）**：飞书入站（收名片图片 + 审批交互）→ 核心闭环
- **第三阶段（稳定后）**：企业微信接入 + cc-lark MCP 深度集成（多维表格、文档协作）
