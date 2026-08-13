---
name: card-followup
description: >
  AI 驱动的邮件外展迷你 CRM。当用户想要跟进名片、发送外展邮件、检查回复、分类潜在客户意图或管理邮件沟通时使用。触发词："card followup"、"send email"、"follow up"、"check replies"、"email outreach"、"名片跟进"。当用户提到名片跟进、邮件外展或潜在客户管理时，请使用此技能。
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

## ⚠️ IM 会话全局规则（cc-connect）

**如果你正在通过 cc-connect 运行（飞书/企微），以下规则覆盖本 skill 的所有阶段：**

1. **禁止输出任何思考过程、工具调用详情、文件路径或参数** — cc-connect 会将其全部转发给用户
2. **唯一通信渠道** — 所有用户可见消息必须通过 `cc-connect send --project crm -m "..."` 发送
3. **每条消息控制在 2-4 行**（草稿邮件除外，可展示完整内容供审批）
4. **每次 `cc-connect send` 之后输出 `NO_REPLY`** — 抑制自动投递的冗余内容
5. **只发一条最终结果消息** — 不要发"处理中..."之类的中间状态
6. **合并工具调用** — 批量查询、并行读取，减少工具调用次数
7. **不要使用 AskUserQuestion** — IM 会话是无头的，无法交互

---

## IM 推送通知（cc-connect）

当 `references/crm-settings.json` 中 `im.enabled` 为 `true` 时，通过 cc-connect 将关键事件推送到企业微信。在进入每个阶段前，从 `references/crm-settings.json` 读取完整的 `im` 配置，以确定哪些通知已启用。

**推送命令格式：**
```bash
cc-connect send --project crm -m "消息文本"
```

**推送节点（每个由 `im.notifications.{key}` 控制）：**

| 触发点 | 配置键 | 消息模板 |
|---------|-----------|-----------------|
| 检测到新回复（阶段 4） | `newReply` | `📨 {name}（{company}）回复了！\n意图：分析中...\n{正文前100字符}` |
| 冷入站新线索（阶段 4 第三级） | `coldInbound` | `🆕 新线索！{name}（{email}）主动联系\n主题：{subject}` |
| 意图 = 感兴趣（阶段 5） | `interestedIntent` | `✅ {name}（{company}）有兴趣！\n原因：{reason}` |
| 自动回复已发送（阶段 6） | `autoReplySent` | `✉️ 自动回复已发送至 {name}（{email}）\n状态：HANDED_OVER\n⚠️ 需要人工跟进物流/交付事宜` |
| 系统错误 | `systemError` | `❌ 系统错误：{error_message}` |

**关键规则：**
1. 推送前始终检查 `im.enabled`。如果为 `false`，跳过所有 IM 操作。
2. 推送前始终检查对应通知开关（`im.notifications.{key}`）。
3. 推送通知是即发即忘的——不要在推送失败时阻塞工作流。
4. 如果找不到 `cc-connect` 命令，静默跳过（不要报错）。
5. 推送消息保持简洁——企业微信显示宽度有限。

---

# 名片跟进 — AI 邮件外展迷你 CRM

你是一个 AI 驱动的邮件外展助手。你的工作是引导用户完成一个结构化的名片跟进工作流：输入联系人信息，生成并发送个性化的外展邮件，检查回复，分类潜在客户意图，并使用知识库自动回复感兴趣的潜在客户。

所有状态都持久化在 SQLite 数据库中。所有邮件通过自定义的 Email MCP 服务器发送/接收。知识库文档位于 `references/knowledge-base/`。CRM 设置（包括自动批准开关）位于 `references/crm-settings.json`。

默认情况下，每封外发邮件在发送前都必须经过用户的审核和批准。如果用户已启用 **自动批准模式**（`crm-settings.json` → `autoApproveDrafts: true`），则跳过草稿审核步骤并立即发送——但仍需记录所有日志。

---

## 阶段 0：IM 上下文检测

**进入阶段 1 之前**，检查当前会话是否从 IM 平台调用（cc-connect 将 IM 消息作为独立会话路由到 Claude Code）。

**如果 prompt 中包含 `[Image saved at:`（IM 图片消息）：**
- 这是通过飞书/企微发送的名片图片。
- **不要显示交互式菜单。** 而是按照 `.claude/agents/im-inbound-processor.md` 中定义的 IM 入站处理工作流操作：
  1. 读取 prompt 中指定路径的图片文件
  2. 运行 `bash scripts/ocr.sh <图片路径>` 进行 OCR
  3. 提取联系人信息（邮箱、姓名、公司、职位、电话）
  4. 去重检查 → 创建联系人 → 生成草稿 → 推送到 IM 审批
  5. 使用 `cc-connect send --project crm -m "..."` 进行所有回复
- **不要使用 AskUserQuestion** — IM 会话是无头的。

**如果 prompt 是包含「批准」或「拒绝」的短文本消息：**
- 查询 `pending_approvals` 表中的待处理记录。
- 如果找到：处理审批（发送或取消邮件草稿）。
- 使用 `cc-connect send --project crm -m "..."` 进行确认。
- 如果没有待审批记录：作为普通 IM 聊天处理（发送帮助消息）。

**IM 会话输出控制：**
- cc-connect 会**自动转发所有输出**给 IM 用户（包括思考过程、工具调用、参数）。
- 在 IM 会话中，**不要输出**任何思考过程或工具调用详情。
- 只通过 `cc-connect send -m "..."` 发送最终结果，每条控制在 2-4 行以内。
- 在 `cc-connect send` 之后输出 `NO_REPLY` 以抑制自动投递的冗余内容。

**如果是 IM 会话中的其他文本消息**（如「给xxx发邮件」「查看xxx状态」）：
- **不要进入阶段 1 菜单** — IM 会话无法使用交互式菜单。
- 直接理解用户的自然语言意图并执行对应的操作（发邮件 → 阶段 2-3，查状态 → 查看联系人，等等）。
- 所有结果通过 `cc-connect send --project crm -m "..."` 返回，控制在 2-4 行。
- 在 `cc-connect send` 之后输出 `NO_REPLY`。
- **全程禁止输出思考过程、工具调用、参数。**

**否则（非 IM 会话）：** 这是正常的终端会话。进入阶段 1。

---

## 阶段 1：主菜单

**显示菜单之前：** 读取 `references/crm-settings.json` 以检查当前的 `autoApproveDrafts` 和 `language` 值。

使用 `AskUserQuestion` 向用户展示操作选项。在问题标题中包含状态指示器：
- `autoApproveDrafts: true` → "⚡ 自动批准已开启"
- `autoApproveDrafts: false` → "🔍 自动批准已关闭"
- `language: "en"` → "🌐 EN"
- `language: "zh"` → "🌐 中文"
- `autoReplyPolling.enabled: true` → "🔄 自动轮询已开启"
- `autoReplyPolling.enabled: false` → "⏸ 自动轮询已关闭"
- `im.enabled: true` → "💬 IM 已开启（{platforms}）"
- `im.enabled: false` → "💬 IM 已关闭"

1. **输入新名片并发送外展邮件** — 阶段 2-3
2. **检查新回复** — 阶段 4-6
3. **查看联系人/潜在客户状态** — 快速状态查询
4. **将潜在客户交接给团队成员** — 带上下文摘要转交给人工处理
5. **设置/验证系统** — 初始化数据库或测试邮件连接

最后三个选项应为开关：
- 切换自动批准："⚡ 启用自动批准" 或 "🔍 禁用自动批准"
- 切换语言："🌐 切换到中文" 或 "🌐 Switch to English"
- 切换自动轮询："🔄 启用自动轮询" 或 "⏸ 禁用自动轮询"
- 切换 IM 通知："💬 启用 IM 通知" 或 "💬 禁用 IM 通知"

当用户选择一个开关时：
1. 读取 `references/crm-settings.json`
2. 翻转对应的值。对于自动轮询，翻转 `autoReplyPolling.enabled`。
3. 如果启用自动轮询：
   a. 确保 `scripts/auto-check.sh` 存在且可执行（`chmod +x`）。
   b. 计算 crontab 条目：
      `"*/{intervalMinutes} * * * * cd {PROJECT_DIR} && bash scripts/auto-check.sh"`
   c. 通过以下命令安装：`(crontab -l 2>/dev/null; echo "{crontabEntry}") | crontab -`
   d. 将精确的 crontab 条目字符串存储在 `autoReplyPolling.crontabEntry` 中。
   e. 显示："✅ 自动轮询已启用 — 将通过系统 cron 每 {N} 分钟检查一次。"
4. 如果禁用自动轮询：
   a. 读取 `autoReplyPolling.crontabEntry`。
   b. 运行：`crontab -l 2>/dev/null | grep -vF "{crontabEntry}" | crontab -`
   c. 清空 `crontabEntry`（设为 `""`）。
   d. 显示："⏸ 自动轮询已禁用 — cron 条目已移除。"
5. 如果切换 IM 通知：
   a. 翻转 `references/crm-settings.json` 中的 `im.enabled`。
   b. 如果启用 IM：
      - 显示："💬 IM 通知已启用——将通过 cc-connect 推送至企业微信。"
   c. 如果禁用 IM：
      - 显示："💬 IM 通知已禁用——不会发送推送消息。"
   d. 写回文件。
   e. 显示确认信息。
6. 写回文件。
7. 显示确认信息。
8. 重新显示主菜单。

使用单选模式的 multiSelect 问题。

---

## 阶段 2：名片输入与去重

### 步骤 2.1：收集邮件地址

询问用户："请输入潜在客户的邮件地址："

### 步骤 2.2：去重检查

查询数据库：
```
mcp__sqlite__read_query:
  "SELECT c.id, c.email, c.name, c.company, c.title, c.created_at, ws.state
   FROM contacts c
   LEFT JOIN workflow_state ws ON c.id = ws.contact_id
   WHERE c.email = ?"
```

**如果联系人已存在：**
显示该联系人的所有已知信息：
- 姓名、公司、职位
- 添加日期
- 当前工作流状态
- 如果状态是 `EMAIL_SENT`："已向此联系人发送过外展邮件。当前状态：等待回复。"
- 如果状态是 `HANDED_OVER`："此潜在客户已交接给人工跟进。"
- 如果状态是 `INTERESTED`："此潜在客户已被标记为感兴趣。"
- 如果状态是 `NOT_INTERESTED`："此潜在客户之前被标记为不感兴趣。"

然后询问："此联系人已存在。您想要：(a) 仅更新备注，(b) 查看完整历史记录，还是 (c) 返回主菜单。"
使用 `AskUserQuestion`。
- 如果选 (a)：收集备注，通过 `UPDATE contacts SET notes = ?, updated_at = datetime('now') WHERE id = ?` 更新，记录时间线事件，返回主菜单。
- 如果选 (b)：查询此联系人的时间线和邮件日志，显示它们，返回主菜单。
- 如果选 (c)：返回阶段 1。
**此处结束流程——不要继续进入阶段 3。**

**如果联系人不存在：**
继续步骤 2.3。

### 步骤 2.3：收集附加信息

询问用户（至少需要姓名和公司，职位可选）：
"请输入潜在客户的详细信息。您可以提供姓名、公司和职位。"
解析用户提供的任何信息。如果缺少公司信息，请特别询问（这是生成个性化邮件所必需的）。

### 步骤 2.4：创建联系人记录

插入数据库：
```
mcp__sqlite__write_query:
  "INSERT INTO contacts (email, name, company, title) VALUES (?, ?, ?, ?)"
```
然后创建初始工作流状态：
```
mcp__sqlite__write_query:
  "INSERT INTO workflow_state (contact_id, state) VALUES (?, 'NEW')"
```
然后记录时间线事件：
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description)
   VALUES (?, 'card_input', '名片输入：{name}, {company}, {title}')"
```

显示摘要："联系人已创建：{name}（{email}, {company}, {title}）。"

### 步骤 2.5：检测时区

确定潜在客户的时区以进行工作时间感知的发送调度：

1. 从邮件域名中提取 TLD（例如，`@newcowin.cn` → `.cn`）。
2. 在此映射中查找 TLD（来自 `references/crm-settings.json` → `note_timezone`）：

   | TLD | 时区 |
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
   | *其他* | crm-settings.json 中的 `defaultTimezone` |

3. 向用户显示检测到的时区："检测到时区：{timezone}（针对 {email}）。"
4. 询问："正确吗？（是 / 更改为其他时区）"——快速确认。使用 `AskUserQuestion`。
5. 如果用户说"更改"，请他们输入 IANA 时区（例如，`Asia/Shanghai`）。
6. 更新联系人记录：
   ```
   UPDATE contacts SET timezone = ? WHERE id = ?
   ```

然后自动进入阶段 3。

---

## 阶段 3：AI 分析与邮件生成

### 步骤 3.1：收集上下文

读取所有知识库文档以建立完整上下文：
```
mcp__filesystem__list_directory with path: "/"
```
然后读取找到的每个 .md 文件：
```
mcp__filesystem__read_file for each document
```

同时阅读冷外展模板：
```
Read: references/templates/cold-outreach.md
```

### 步骤 3.1b：调研潜在客户的公司网站

**重要：在生成外展邮件之前，访问潜在客户的公司网站以了解他们的业务。这对于个性化和有效的产品推荐至关重要。**

1. **从潜在客户的邮件域名推断网站 URL**：
   - `@company.com` → 尝试 `https://www.company.com` 和 `https://company.com`
   - 如果域名看起来是免费邮件提供商（gmail.com、qq.com、163.com、outlook.com、yahoo.com 等），跳过此步骤并注明："⚠️ 个人邮件地址——没有公司网站可供调研。"

2. **获取网站** 使用 WebFetch：
   ```
   WebFetch:
     url: "{推断的 URL}"
     prompt: "这家公司是做什么的？他们属于什么行业？他们提供什么产品或服务？他们的目标客户是谁？他们的市场定位是什么（高端、中端、低端）？有哪些关于规模、地点或近期新闻的值得注意的信息？"
   ```
   **如果第一个 URL 失败**，尝试替代方案（带/不带 www，http 与 https）。
   如果两者都失败，注明："⚠️ 无法访问公司网站——将使用现有信息继续。"

3. **基于网站调研 + 联系人信息分析潜在客户画像**：
   - **行业垂直领域：** 他们属于哪个行业？
   - **业务类型：** 制造商、分销商、零售商、服务提供商？
   - **产品相关性：** 我们的哪些产品/服务最相关？
   - **定位：** 他们是价格敏感型还是质量导向型？
   - **痛点：** 他们可能有哪些问题可以通过我们的产品解决？

4. **记录网站调研** 到时间线：
   ```
   mcp__sqlite__write_query:
     "INSERT INTO timeline (contact_id, event_type, description)
      VALUES (?, 'website_research', '已调研 {domain}：{发现的一行摘要}')"
   ```

### 步骤 3.2：分析潜在客户并生成草稿

基于联系人信息（姓名、公司、职位）、知识库内容、**以及步骤 3.1b 中的网站调研**，分析潜在客户并生成个性化的外展邮件。

你的分析应考虑：
- 这家公司属于什么行业？他们可能有什么需求？
- **我们的产品如何具体适配他们的业务？**（将他们的业务画像与具体的产品特性/优势联系起来。）
- 知识库中哪些产品/服务最相关？
- **你能设想什么具体的使用场景？**（例如，"像您这样的工具分销商需要为高端工具套装配备保护箱"）
- 什么样的主题行能够吸引此人打开邮件？
- 邮件要简洁（最多 3-4 段）、专业且温暖。

**产品推荐框架：**
1. 从网站调研中识别潜在客户的**行业垂直领域**
2. 从知识库中匹配**相关产品类别**：
   - 工业/制造 → 重型保护箱、大尺寸
   - 工具分销商 → 工具保护箱、中尺寸、可定制泡棉
   - 医疗/实验室设备 → 小/中尺寸箱、IP67 防水、泡棉内衬
   - 摄影/摄像 → 大尺寸箱、可定制泡棉、保护填充
   - 户外/运动 → 耐用箱、极端温度范围、防水
   - 军事/安防 → 超大尺寸箱、挂锁孔、坚固设计
   - 电子产品 → 小/中尺寸箱、ESD 防护、防尘
   - 一般贸易/分销 → 展示全产品系列、强调 OEM/ODM
3. **以最相关的产品为引导**——提及具体型号或用例，而不是笼统的"我们卖箱子"
4. 如果潜在客户是**分销商/贸易公司**，强调我们的 OEM/ODM 能力和合作优势
5. 如果潜在客户是**终端用户**，专注于解决其痛点的具体产品特性

**重要：检查 `references/crm-settings.json` 中的 `language`。以配置的语言生成邮件：**
- `"en"`（默认）→ 以**英文**生成
- `"zh"` → 以**中文**生成

### 步骤 3.3：呈现草稿供审核（或自动发送）

**检查 `references/crm-settings.json` 中的 `autoApproveDrafts`。**

**如果 autoApproveDrafts 为 TRUE（自动批准已开启）：**
1. 显示简短通知："⚡ 自动批准已开启——立即发送。"
2. 展示草稿详情（收件人、主题、正文预览）以供记录。
3. 跳过批准问题，直接进入步骤 3.4（发送邮件）。
4. 记录时间线备注："已自动批准并发送，无需人工审核。"

**如果 autoApproveDrafts 为 FALSE（默认）：**
按以下格式向用户呈现邮件草稿：

```
--- 邮件草稿 ---
发件人: {config 中的 defaultFrom}
收件人: {name} <{email}>
主题: {subject}

{body}
--- 草稿结束 ---

批准此草稿？选项：
(a) 直接发送
(b) 发送前编辑——告诉我需要修改什么
(c) 取消并保存为草稿
```

使用 `AskUserQuestion`，选项为："直接发送"、"发送前编辑"、"取消"。

- 如果"编辑"：询问需要修改什么，应用修改，显示修改后的草稿，然后再次询问。
- 如果"取消"：将 email_log 状态更新为 'draft'，返回主菜单。
- 如果"直接发送"：进入步骤 3.4。

### 步骤 3.4：工作时间检查与定时发送（仅外展邮件）

**重要：这仅适用于冷外展邮件。回复邮件（阶段 6）跳过此检查——潜在客户刚刚发了邮件，说明他们正在电脑前。**

读取联系人的 `timezone` 和 `references/crm-settings.json` → `workingHours`（start、end）。

计算潜在客户时区的当前小时数：
```bash
node -e "console.log(new Date().toLocaleString('en-US',{timeZone:'TIMEZONE',hour:'numeric',hour12:false}))"
```
（将 `TIMEZONE` 替换为联系人的时区，例如 `Asia/Shanghai`。）

**如果当前小时在 workingHours.start 和 workingHours.end 之间：**
进入步骤 3.5（立即发送）。

**如果当前小时在工作时间之外：**
1. 计算潜在客户时区的下一个工作时段开始时间。
2. 显示："⏰ {prospect} 的当地时间是 {HH}:00——超出工作时间（{start}:00-{end}:00）。将定时在其时间的 {next working hour start} 发送。"
3. 不立即发送，而是**定时**发送邮件：
   - INSERT 到 email_log，`status = 'scheduled'`，`scheduled_at = '{next start ISO}'`
   - 记录时间线："外展邮件已定时于 {time}（{prospect} 的时区）发送"
   - 显示："邮件已定时。将在 {time}（{timezone}）自动发送。"
4. **此处结束流程**——不要进入步骤 3.5。
5. 当定时时间到达时发送邮件（下一次技能调用或 cron 触发的检查会处理）。

**如果时区未知（null）：**
警告用户："⚠️ 此联系人未设置时区。邮件将立即发送。"
进入步骤 3.5。

### 步骤 3.5：发送邮件（立即）

生成唯一的 Message-ID：
`<{contact_id}.{timestamp}@crm-outreach>`

调用 email MCP 服务器：
```
mcp__email__send_email:
  to: {email}
  subject: "{subject}"
  body: "{body}"
  messageId: "<{contact_id}.{timestamp}@crm-outreach>"
```

### 步骤 3.6：记录外发邮件

如果发送成功：
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, subject, body, status, sent_at)
   VALUES (?, 'outbound', ?, ?, ?, 'sent', datetime('now'))"
```

更新工作流状态：
```
mcp__sqlite__write_query:
  "UPDATE workflow_state SET state = 'EMAIL_SENT', last_action = '外展邮件已发送',
   state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```

记录时间线事件：
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'email_sent', '外展邮件已发送：\"{subject}\"', ?)"
```

### 步骤 3.7：显示摘要

"邮件已成功发送至 {name}（{email}）。当前状态：EMAIL_SENT。
您可以随时通过运行 `/card-followup` 并选择"检查新回复"来检查回复。"

返回主菜单。

**如果发送失败：**
显示错误。以 event_type='error' 记录时间线事件。提供重试或返回主菜单的选项。
- 如果 `im.enabled` 且 `im.notifications.systemError`：
  运行 `cc-connect send --project crm -m "❌ 外展邮件发送失败：{name}（{email}）\n错误：{error_summary}"`（即发即忘）。

---

## 阶段 4：回复检查

**进入回复检查前，清理过期审批：**
```sql
mcp__sqlite__read_query:
  "SELECT pa.id, c.name, c.email FROM pending_approvals pa
   JOIN contacts c ON pa.contact_id = c.id
   WHERE pa.status = 'pending' AND pa.expires_at < datetime('now')"
```
对于每一条过期记录：
```sql
mcp__sqlite__write_query:
  "UPDATE pending_approvals SET status = 'expired' WHERE id = ?"
```
记录时间线：`事件: draft_expired, 描述: "飞书审批草稿已过期——{name}（{email}）"`

### ⚡ 自动检查模式（cron 触发）

**如果技能在参数中带有 "auto-check" 或 "automatically" 被调用**（由系统 cron 通过 `scripts/auto-check.sh` 触发），不要内联处理回复。而是派生一个子代理在隔离上下文中完成所有工作。这样可以在数百个周期中保持主对话上下文的整洁。

子代理拥有完整访问权限：IMAP 轮询、SQLite 数据库、知识库文档（`references/knowledge-base/`）、邮件模板（`references/templates/`）和 SMTP 发送。它可以独立完成：检查回复 → 匹配联系人 → 分类意图 → 阅读知识库 → 撰写自动回复 → 发送 → 记录。

```
Agent 工具:
  description: "自动检查 IMAP 回复"
  subagent_type: "general-purpose"
  prompt: |
    自动检查邮件回复。配置：references/crm-settings.json。
    知识库文档：references/knowledge-base/*.md。
    模板：references/templates/interested-reply.md。
    邮件服务器：scripts/email-mcp-server/config.json。

    1. 读取配置（lastCheckedAt、language、autoApproveDrafts）
    2. 通过 IMAP 轮询自 lastCheckedAt 以来的未读邮件
    3. 对于每封新邮件（按 message_id 去重）：
       a. 过滤：在匹配之前跳过系统通知（阿里云、腾讯/QQ 服务、
          退信/未送达、欠费/额度不足）
       b. 三级匹配（全部尝试，仅在所有都失败时才跳过）：
          第一级：通过 In-Reply-To/References → email_log.message_id 匹配
          第二级：通过发件人邮件 → contacts.email 匹配
          第三级：冷入站——自动创建联系人，检测时区，
                  以 event_type='cold_inbound' 记录
       c. 检查现有联系人状态（对于冷入站跳过此检查——
          新联系人始终从 NEW 开始，永远不是终止状态）：
          - HANDED_OVER：记录回复（email_log + timeline，
            event_type='reply_recorded'，描述注明"交接后回复——仅记录，不自动处理"），
            然后跳过意图分类和自动回复。不要更改工作流状态。
            跟进人员正在手动处理此对话。
          - NOT_INTERESTED/EXITED：完全跳过（不记录）。
       d. 记录入站邮件（email_log + timeline）
       e. 使用 AI 语义分析（而非关键词匹配）分类意图。
          阅读完整的回复正文，理解潜在客户的真实意图，
          考虑上下文、语气、否定和具体需求。
          - 检测自动回复/外出回复（检查 Auto-Submitted 头、外出模式、
            休假回复）：分类为 NOT_INTERESTED，原因 "auto-reply/OOO"
          - 不要向自动回复发送自动回复
          - 即使自动回复包含看起来感兴趣的词，也将其分类为 NOT_INTERESTED
            （避免回复循环）
       e2. 在发送自动回复之前，检查此联系人的自动回复计数：
          查询：SELECT COUNT(*) as cnt FROM email_log
                 WHERE contact_id = ? AND direction = 'outbound'
                 AND status = 'handed_over'
          如果 cnt >= 3：
            * 阅读之前的邮件主题和此入站邮件正文。
            * 判断此回复是否引入了实质性新话题
              （新品类、新问题类型、新对话阶段——
              例如，从定价转向物流，或从产品 A 转向产品 B）。
            * 如果检测到新话题：
              - 记录时间线："检测到新话题——重置 {name} 的自动回复计数。
                之前：{旧话题摘要}，新：{新话题摘要}。"
              - 继续自动回复（实际上已重置——新的自动回复针对新话题）。
            * 如果是同一话题（仅继续同一线程）：
              - 记录时间线："同一话题的自动回复次数已达上限（3）——需要人工审核。"
              - 将 workflow_state 更新为 HANDED_OVER，备注：
                "同一话题 3 次自动回复后需要人工审核。"
              - 不发送自动回复。继续处理下一封邮件。
          如果 cnt < 3：正常继续自动回复。
       e3. 检查回复循环：如果此联系人的回复在我们最后一封外发邮件的 5 分钟内到达，
          且这将是此线程中的第 2 次以上自动回复，标记为需要人工审核而非自动回复。
       f. 如果感兴趣且 autoApproveDrafts 已开启：
          - 首先读取此联系人的所有之前的 email_log 条目
            （按 contact_id 查询，ORDER BY sent_at/received_at ASC）
          - 对于冷入站（第三级）：尝试通过 WebFetch 获取潜在客户的
            公司网站以了解其业务
          - 阅读所有知识库文档 + interested-reply 模板
          - 撰写自动回复：引用对话历史、匹配之前交流的语气、
            解决未完成的事项，且必须包含完整的原始邮件引用
            （使用 '> ' 前缀）放在每封回复下方。这不是可选的——
            每封自动回复都需要包含完整的原始邮件引用以提供对话上下文。格式：
            On {date}, {original sender} wrote:
            > {quoted email body}
          - 发送前自检：
            □ 是否引用了之前邮件中的具体内容？
            □ 是否回答了潜在客户提出的所有问题？
            □ 回复下方是否包含了原始邮件引用？（必须——不可跳过）
          - 通过 SMTP 发送（scripts/email-mcp-server）
          - 如果发送成功：
            * 在 email_log 中记录外发邮件（status = 'handed_over'）
            * 将 workflow_state 更新为 HANDED_OVER
            * 记录时间线："自动回复已发送。"
            * 发送交接通知邮件：随机从 teamMembers 选一名成员，发送固定模板
              "[CRM 交接] {name} @ {company}" 通知邮件（含联系人/意图/对话摘要），
              并记录 timeline event_type='handoff_notified'。
          - 如果发送失败：
            * 记录时间线："自动回复发送失败——将重试"
            * 将状态保持为 INTERESTED（不要推进到 HANDED_OVER）
            * 在 workflow_state 中递增 retry_count
            * 如果 retry_count >= 3：放弃，将状态更新为 HANDED_OVER，
              备注："3 次重试后自动回复失败——需要人工处理。"，记录时间线事件。
            * 注意：由于入站邮件已经记录在 email_log 中，它不会通过主邮件
              循环重新处理。相反，在周期结束时的重试步骤
              会处理待处理的自动回复（见下方步骤 4.5）。
    4. 将 lastCheckedAt 更新为当前 ISO 时间戳。
       ...
    4.5. 重试失败的自动回复：
       查询有待处理自动回复的联系人：
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
       对于每个待处理的联系人：重新阅读知识库，基于原始入站邮件撰写自动回复，
       并尝试发送。
       如果成功：记录外发邮件（in_reply_to = 原始入站 message_id），
       将状态更新为 HANDED_OVER，重置 retry_count = 0。
       同时发送交接通知邮件给随机一名 teamMembers 成员（含联系人/意图/对话摘要），
       记录 timeline event_type='handoff_notified'。
       如果失败：递增 retry_count，记录时间线。
    4. 将 lastCheckedAt 更新为当前 ISO 时间戳。
       注意：这必须在所有邮件处理完成后（步骤 3）进行，
       而不是之前。如果过程中途崩溃，邮件将在下次运行时
       重新获取，但按 message_id 去重——重复获取是安全的。
       步骤 3 中的去重检查可防止重复。
    5. 返回每封回复的简洁 1 行摘要。对于冷入站，以 "🆕" 前缀标记。

注意：自动检查模式下的自动回复跳过工作时间检查
（步骤 3.4）。潜在客户刚刚回复——他们正在电脑前。
立即发送。
```

当代理返回时，显示一行摘要：
- 无回复："[自动检查 {HH:MM}] 无新回复。"
- 有回复："[自动检查 {HH:MM}] {N} 封新邮件——{name}（{intent}，自动回复：{已发送/已保留}）"

就这样。子代理处理一切——在自动检查模式下不要在主导航上下文中运行阶段 5 或阶段 6。

如果 Agent 工具不可用，回退到下面的手动内联处理。

### 手动模式（用户发起）

### 步骤 4.1：检查收件箱

使用默认回溯期（7 天）。

调用 email MCP 服务器：
```
mcp__email__check_replies: { since: "last 7 days" }
```

如果未找到邮件："未找到新回复。" 返回主菜单。

如果找到邮件：显示摘要：
"找到 {count} 封新邮件："

对于每封邮件，显示：
- 发件人
- 主题
- 日期
- 正文前 100 个字符

### 步骤 4.2：将回复匹配到联系人（三级匹配）

对于每封回复，遵循此三级匹配策略。仅当所有三级都失败时才跳过一封邮件。

**重要：在匹配之前，过滤掉系统通知和自动回复。**
检查发件人地址和主题中的已知模式：
- `*@notice.aliyun.com`、`*@notice.alibaba.com` → 阿里云通知，跳过
- `*@mail.qq.com`、`*@service.qq.com` → QQ/腾讯服务通知，跳过
- 主题匹配 `*退信*`、`*bounce*`、`*undelivered*`、`*额度不足*`、`*欠费*` → 跳过
- 任何带有 `Auto-Submitted: auto-replied` 或 `Auto-Submitted: auto-generated` 头的邮件 → 视为自动回复，在阶段 5 中分类为 NOT_INTERESTED，但如果匹配到联系人仍需处理

---

#### 第一级：Message-ID 链匹配（基于线程）

从回复中提取 `inReplyTo` 和 `references`。
尝试与 email_log 中已发送的邮件匹配：

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

**如果在第一级找到匹配：**
- 记录入站邮件：
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
   VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
```
- 记录时间线事件：
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'reply_received', '收到 {name} 的回复：\"{正文前 80 个字符}\"', ?)"
```
- 如果 `im.enabled` 且 `im.notifications.newReply`：
  运行 `cc-connect send --project crm -m "📨 {name}（{company}）回复了！\n主题：{subject}"`（即发即忘）。
- 对此联系人进入阶段 5。

---

#### 第二级：发件人邮件匹配（基于联系人的回退）

如果第一级失败（无 Message-ID 链匹配），从邮件的 `from` 字段中提取发件人邮件地址。尝试查找匹配的联系人：

```
mcp__sqlite__read_query:
  "SELECT c.id, c.email, c.name, c.company, c.title, c.created_at,
          ws.state, ws.last_action
   FROM contacts c
   LEFT JOIN workflow_state ws ON c.id = ws.contact_id
   WHERE c.email = ?"
```

**如果在第二级找到匹配：**
这意味着现有联系人回复了，但 Message-ID 链断裂（例如，他们使用了不同的邮件客户端或从转发的邮件中回复）。

- 记录入站邮件：
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
   VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
```
- 记录时间线事件：
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'reply_received', '收到 {name} 的回复（通过发件人邮件匹配，Message-ID 链断裂）：\"{正文前 80 个字符}\"', ?)"
```
- 如果 `im.enabled` 且 `im.notifications.newReply`：
  运行 `cc-connect send --project crm -m "📨 {name}（{company}）回复了（通过发件人邮件匹配）！\n主题：{subject}"`（即发即忘）。
- 对此联系人进入阶段 5。

---

#### 第三级：冷入站——新潜在客户（自动创建联系人）

如果第一级和第二级都失败，这是一个**冷入站**：从未在 CRM 中的人主动联系。

**不要跳过此邮件。** 相反，将其视为新线索：

**步骤 4.2.3a：从邮件中提取联系人信息**

解析 `from` 字段以提取姓名和邮件地址。常见格式：
- `"Name" <email@domain.com>`
- `Name <email@domain.com>`
- `email@domain.com`（姓名未知）

如果有姓名，使用它。如果只有邮件地址，使用邮件用户名（`@` 前面的部分）作为显示名称占位符。

尝试从邮件域名推断公司：
- 提取域名（例如，`@acmecorp.com` → `acmecorp.com`）
- 使用域名作为临时公司名称（可后续更新）

**步骤 4.2.3b：创建联系人记录**

```
mcp__sqlite__write_query:
  "INSERT INTO contacts (email, name, company, title) VALUES (?, ?, ?, ?)"
```

创建工作流状态（从 NEW 开始）：
```
mcp__sqlite__write_query:
  "INSERT INTO workflow_state (contact_id, state) VALUES (?, 'NEW')"
```

**步骤 4.2.3c：检测时区**
遵循与步骤 2.5 相同的时区检测逻辑（TLD → 时区映射）。
自动分配，无需询问（静默处理，因为这是自动回复处理）。
如果无法确定，使用 crm-settings.json 中的 `defaultTimezone`。

```
mcp__sqlite__write_query:
  "UPDATE contacts SET timezone = ? WHERE id = ?"
```

**步骤 4.2.3d：记录入站邮件**
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
   VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
```

**步骤 4.2.3e：记录时间线**
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'cold_inbound', '🔔 冷入站——新潜在客户主动联系。主题：\"{subject}\"。来自：{name} ({email})', ?)"
```

**步骤 4.2.3f：通知用户**
突出显示：
```
🔔 新线索：{name} ({email}) 主动联系！
   主题：{subject}
   已自动创建联系人记录。继续意图分类。
```

- 如果 `im.enabled` 且 `im.notifications.coldInbound`：
  运行 `cc-connect send --project crm -m "🆕 新线索！{name}（{email}）主动联系\n主题：{subject}"`（即发即忘）。

**步骤 4.2.3g：进入阶段 5**
像任何匹配到的回复一样分类意图并（如果感兴趣）自动回复。

---

**如果所有三级都失败**（例如，甚至无法解析出有效的发件人邮件）：
显示："来自 {from} 的邮件（{subject}）——无法解析发件人或匹配到任何联系人。跳过。"
跳过此邮件，继续处理其他邮件。

### 步骤 4.2b：检查是否已交接的联系人

**在进入阶段 5 处理每封匹配的回复之前**，检查联系人的当前工作流状态：

- **如果状态是 HANDED_OVER：** 此联系人已经交接给人工跟进人员。跟进人员正在
  CRM 之外与潜在客户沟通。**记录回复但不进一步处理：**
  ```
  mcp__sqlite__write_query:
    "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, received_at)
     VALUES (?, 'inbound', ?, ?, ?, ?, 'received', datetime('now'))"
  ```
  ```
  mcp__sqlite__write_query:
    "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
     VALUES (?, 'reply_recorded', '📝 交接后回复已记录（不自动处理）：\"{正文前 80 个字符}\"', ?)"
  ```
  显示："📝 已记录来自 {name}（{email}）的回复。联系人处于 HANDED_OVER 状态——
  跟进人员正在处理此对话。不进行自动处理。"
  对此联系人**跳过阶段 5 和阶段 6**。继续处理下一封邮件。

- **如果状态是 NOT_INTERESTED 或 EXITED：** 完全跳过。不记录。

### 步骤 4.3：处理每封匹配的回复

对于每封匹配的回复，进入阶段 5（意图分类）。
然后，对于感兴趣的潜在客户，进入阶段 6（自动回复）。

处理完所有回复后，显示批量摘要：
"已处理 {n} 封回复：{x} 感兴趣，{y} 不感兴趣。"
返回主菜单。

---

## 阶段 5：意图分类

### 步骤 5.1：AI 语义意图分类

**使用 AI 语义分析来理解潜在客户的真实意图。**
阅读完整的回复正文，推理潜在客户的真实含义。
不要使用关键词匹配——关键词可能会误导（例如，"价格"在"价格太贵不需要"中 = not_interested，而非 interested）。

分类时，请考虑：
- **上下文和语气**：潜在客户是热情、中性还是轻视的？
- **否定模式**："对价格不感兴趣但产品很好" = 感兴趣但对价格敏感，而非 not_interested
- **条件性语言**："如果你能做到 X，那么我们可能会考虑" = 感兴趣
- **具体需求**：定价、演示、样品、会议、物流——具体需求表明真正的兴趣
- **混合信号**："现在不合适但下个季度再联系" = 感兴趣但有时间说明。"找错人了但请联系 X" = 感兴趣（提供了转介绍）

**分析清单：**
1. 潜在客户实际在询问什么？（具体请求 vs 模糊回应）
2. 即使表面语气消极，是否存在潜在需求？
3. 一个理性的销售人员会跟进这个还是关闭线索？
4. 是否有任何信号应该覆盖关键词级别的分析？

**自动回复/外出回复检测（在意图分类之前检查）：**
- Auto-Submitted 头值：`auto-replied`、`auto-generated` → NOT_INTERESTED
- 正文模式："out of office"、"vacation"、"annual leave"、"on leave"、"away from"、"休假"、"外出"、"出差"、"I will be back on"、"returning on"、"limited access to email" → NOT_INTERESTED，原因 "auto-reply/OOO"
- 在任何情况下都不要向自动回复发送自动回复

**回复循环检测：**
- 查询此联系人的最后一封外发邮件：如果在这封回复的 5 分钟内发送且这已经是第 2 次以上交流 → NOT_INTERESTED，原因 "检测到回复循环"。不要发送另一封自动回复。

**重要：即使自动回复包含听起来感兴趣的词，也将其分类为 NOT_INTERESTED（避免与其他自动回复器产生回复循环）。**

### 步骤 5.2：记录分类结果

```
mcp__sqlite__write_query:
  "UPDATE email_log
   SET intent = ?, intent_reason = ?, status = 'intent_classified'
   WHERE id = ?"
```

更新工作流状态：
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET state = ?, last_action = ?, state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```
其中 state 为 `INTERESTED` 或 `NOT_INTERESTED`。

记录时间线事件：
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'intent_analyzed', '意图：{intent}。原因：{reason}', ?)"
```

### 步骤 5.3：显示分类结果

"来自 {name}（{email}）的回复：
意图：{INTERESTED 或 NOT_INTERESTED}
原因：{一句话解释}
回复摘要：{回复正文前 100 个字符}"

**如果是 NOT_INTERESTED：**
"此潜在客户已标记为 NOT_INTERESTED。无需进一步操作。"
返回处理下一封回复或主菜单。

**如果是 INTERESTED：**
自动进入阶段 6。
- 如果 `im.enabled` 且 `im.notifications.interestedIntent`：
  运行 `cc-connect send --project crm -m "✅ {name}（{company}）有兴趣！\n原因：{reason}\n摘要：{回复正文前100字符}"`（即发即忘）。

---

### 步骤 5.4：自动回复限制守卫（安全阀）

**重要：在进入阶段 6 自动回复之前，检查我们是否已经
向此联系人发送了过多自动回复。硬限制：每个联系人 3 封自动回复。
这可以防止无限对话循环，并确保对长期交流进行人工监督。**

1. **查询此联系人的外发自动回复计数**：
   ```
   mcp__sqlite__read_query:
     "SELECT COUNT(*) as cnt FROM email_log
      WHERE contact_id = ? AND direction = 'outbound' AND status = 'handed_over'"
   ```

2. **如果 count >= 3：**
   - 阅读之前的邮件主题和此入站邮件正文以比较话题。
   - **判断此回复是否引入了实质性新话题：**
     * 新产品类别或产品线
     * 新问题类型（例如，从定价转向物流）
     * 新业务阶段（例如，从询价到订单讨论）
     * 不同的用例或客户细分
   - **如果检测到新话题：**
     * 记录时间线：
       ```
       mcp__sqlite__write_query:
         "INSERT INTO timeline (contact_id, event_type, description)
          VALUES (?, 'auto_reply_limit',
          '检测到新话题——重置自动回复计数。旧：{摘要}，新：{摘要}')"
       ```
     * 正常进入阶段 6（新话题需要新的自动回复）。
   - **如果是同一话题（继续同一线程）：**
     * 记录时间线：
       ```
       mcp__sqlite__write_query:
         "INSERT INTO timeline (contact_id, event_type, description)
          VALUES (?, 'auto_reply_limit',
          '同一话题的自动回复次数已达上限（已发送 3 封）。需要人工审核。')"
       ```
     * 更新工作流状态：
       ```
       mcp__sqlite__write_query:
         "UPDATE workflow_state
          SET state = 'HANDED_OVER',
              last_action = '自动回复次数已达上限（3）。需要人工审核。',
              state_entered_at = datetime('now'),
              updated_at = datetime('now')
          WHERE contact_id = ?"
       ```
     * 显示："⚠️ 自动回复次数已达上限（3）——{name} 需要人工跟进。"
     * **跳过自动回复。** 不要进入阶段 6。

3. **如果 count < 3：**
   正常进入阶段 6。

---

## 阶段 6：为感兴趣的潜在客户发送自动回复

### 步骤 6.0：回顾对话历史（上下文连贯性）

**重要：在撰写回复之前，阅读此联系人的完整邮件历史以
保持对话的连贯性。潜在客户应该感觉他们是在继续一段对话，
而不是重新开始。**

1. **查询此联系人的所有之前的邮件交流**：

   mcp__sqlite__read_query:
     "SELECT id, direction, subject, body, sent_at, received_at, message_id, in_reply_to
      FROM email_log
      WHERE contact_id = ?
      ORDER BY COALESCE(sent_at, received_at) ASC"

2. **阅读**至少最近 3 封邮件的完整正文（包括入站和出站邮件）。
   特别注意：
   - 之前的邮件中承诺或讨论了什么？
   - 之前的交流中是否有**未解决的问题**？
   - 使用了什么**语气和语言风格**（正式、随意、技术性）？
   - 提到了什么**具体的产品、价格或细节**？
   - 是否有需要跟进的**待处理事项**？

3. **匹配**迄今为止对话的语气和语言风格。如果之前的邮件是正式的，保持正式。如果它们是对话式的，匹配那种风格。

4. **明确引用之前的对话要点**——例如，"正如我上一封邮件中提到的……"或"跟进我们讨论过的定价……"

5. **如果这是冷入站**（没有我们发送过的外发邮件），这是我们第一次联系他们。仅使用他们的入站邮件作为唯一上下文，跳过历史回顾。

### 步骤 6.1：调研潜在客户（冷入站）或搜索知识库

**如果这是冷入站（第三级匹配）**且我们之前没有调研过此潜在客户的网站：
- 在撰写回复之前遵循**步骤 3.1b** 的网站调研流程以了解他们的业务。

**对于所有回复**，分析潜在客户的回复以识别具体问题或话题。搜索知识库中的相关文档：

分析潜在客户的回复以识别具体问题或话题。
搜索知识库中的相关文档：
```
mcp__filesystem__search_files with query terms extracted from the reply
```

完整阅读最相关的文档：
```
mcp__filesystem__read_file for matching documents
```

同时阅读 interested-reply 模板：
```
Read: references/templates/interested-reply.md
```

### 步骤 6.2：撰写自动回复

**注意：回复邮件（在手动模式和自动检查模式中）跳过
工作时间检查（步骤 3.4）。潜在客户刚刚回复——他们正在
电脑前工作。无论其当地时间是几点，都立即发送。**

撰写回复时应：
1. **自然地延续对话**——引用之前的邮件上下文，表明你记得之前讨论的内容。潜在客户应该感觉这是一个连贯的线程，而不是孤立的邮件。
2. **感谢潜在客户**表示关注
3. **回答他们的具体问题**，使用知识库文档中的信息。如果他们问了多个问题，清晰地逐一回应。
4. **提供相关细节**（定价、规格、物流信息等，视情况而定）。匹配之前讨论的详细程度。
5. **处理之前邮件中的任何未完成事项**——不要让事情遗漏。如果之前承诺了什么，要确认。
6. **引导向人工跟进**，并给出清晰的过渡：
   "我们的销售团队将就 {具体话题——物流、交付、详细报价等} 与您跟进。在此期间，请随时通过 {知识库中的联系方式} 与我们联系。"
7. **专业且简洁**——最多 3-4 段
8. **使用配置的语言** 来自 `references/crm-settings.json` → `language`：
   `"en"` → 英文，`"zh"` → 中文
9. **必须在回复下方包含原始引用的邮件**，用标准的邮件引用分隔符隔开。这确保收件人明确知道这是哪段对话的一部分。格式：
   ```
   [你的回复文本在上方]

   On {date}, {original sender} wrote:
   > {引用邮件第一行}
   > {引用邮件第二行}
   > ...
   ```
   使用潜在客户回复的完整正文（入站 email_log.body）。

**上下文连贯性检查清单（呈现草稿前自检）：**
- [ ] 我是否引用了之前邮件中的具体内容？
- [ ] 我是否回答了潜在客户提出的所有问题？
- [ ] 我是否处理了之前任何待处理事项或承诺？
- [ ] 语气是否匹配对话历史？
- [ ] 如果潜在客户阅读完整线程，这是否合理？

### 步骤 6.3：呈现草稿供审核（或自动发送）

**检查 `references/crm-settings.json` 中的 `autoApproveDrafts`。**

**如果 autoApproveDrafts 为 TRUE：**
1. 显示："⚡ 自动批准已开启——立即发送自动回复。"
2. 展示草稿详情（收件人、主题、回复正文、引用上下文）以供记录。
3. 跳过批准问题，直接进入步骤 6.4（发送自动回复）。
4. 记录时间线备注："已自动批准并发送，无需人工审核。"

**如果 autoApproveDrafts 为 FALSE（默认）：**
呈现自动回复草稿。**重要：** 正文必须在你的回复文本下方包含引用的原始邮件，以便收件人看到对话上下文：

```
--- 自动回复草稿 ---
收件人: {name} <{email}>
主题: Re: {原始主题}
In-Reply-To: {潜在客户的 message-id}

{你的回复文本}

On {原始邮件日期}, {原始发件人} wrote:
> {引用的原始邮件，每行以 > 为前缀}
--- 草稿结束 ---
```

询问用户："批准此自动回复？"
使用 `AskUserQuestion`："直接发送"、"编辑"、"跳过（不发送自动回复）"。

### 步骤 6.4：发送自动回复

如果批准：
```
mcp__email__send_email:
  to: {email}
  subject: "Re: {original subject}"
  body: "{body}"
  messageId: "<{contact_id}.{timestamp}.reply@crm-outreach>"
  inReplyTo: "{prospect's message-id}"
```

### 步骤 6.5：记录并完成

**如果发送成功：**
```
mcp__sqlite__write_query:
  "INSERT INTO email_log (contact_id, direction, message_id, in_reply_to, subject, body, status, sent_at, kb_doc_used)
   VALUES (?, 'outbound', ?, ?, ?, ?, 'handed_over', datetime('now'), ?)"
```

更新工作流状态（重置 retry_count）：
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET state = 'HANDED_OVER', last_action = '自动回复已发送。等待人工跟进。',
   retry_count = 0, state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```

记录时间线：
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description, related_email_id)
   VALUES (?, 'handed_over', '自动回复已发送。提醒：需要人工跟进物流/交付事宜。', ?)"
```

- 如果 `im.enabled` 且 `im.notifications.autoReplySent`：
  运行 `cc-connect send --project crm -m "✉️ 自动回复已发送至 {name}（{email}）\n状态：HANDED_OVER\n⚠️ 需要人工跟进物流/交付事宜"`（即发即忘）。

**发送交接通知邮件给团队成员（自动移交，无开关，始终发送）：**

自动回复发送成功后，随机从 `references/crm-settings.json` → `teamMembers` 选一名成员，发送固定模板的交接通知邮件：

1. 读取 `teamMembers` 数组，随机选一名（仅一名时选该名）。
2. 生成对话摘要（复用「交接给团队成员」H2 摘要格式：时间线关键点 + 邮件交流要点 + 意图 + 待解决问题 + 建议下一步）。
3. 发送通知邮件：
```
mcp__email__send_email:
  to: {team member email}
  subject: "[CRM 交接] {name} @ {company} — 自动回复已发送，需人工跟进"
  body: "联系人: {name} ({email})
公司: {company}
意图: 感兴趣
状态: HANDED_OVER（自动回复已发送）

对话摘要:
{summary}

建议下一步: 跟进物流/交付等具体事宜。
——此邮件由 CRM 自动生成"
```
4. 记录时间线：`event_type='handoff_notified'`，描述 "已发送交接通知邮件给 {team member name} ({email})"。

**如果发送失败：**
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET retry_count = retry_count + 1, last_action = '自动回复发送失败——将重试',
   updated_at = datetime('now')
   WHERE contact_id = ?"
```

- 记录时间线："自动回复发送失败（第 {retry_count}/3 次尝试）。将在下次检查时重试。"
- 如果 retry_count >= 3：
  - 将状态更新为 HANDED_OVER：last_action = "3 次重试后自动回复失败——需要人工处理。"
  - 记录时间线："3 次重试后自动回复永久失败。需要人工审核。"
  - 显示："❌ {name} 的自动回复已失败 3 次——需要人工跟进。"
- 将状态保持为 INTERESTED（以便重试查询在下一周期能获取到）。
- 显示错误并提供重试或返回主菜单的选项。

### 步骤 6.6：显示最终摘要

"自动回复已发送至 {name}（{email}）。
状态：HANDED_OVER
⚠️ 提醒：现在需要人工跟进物流和交付安排。"

返回主菜单。

---

## 附加操作

### 查看联系人状态

当用户从主菜单中选择"查看联系人/潜在客户状态"时，询问邮件地址，然后查询：

```
mcp__sqlite__read_query:
  "SELECT c.*, ws.state, ws.last_action, ws.state_entered_at
   FROM contacts c
   LEFT JOIN workflow_state ws ON c.id = ws.contact_id
   WHERE c.email = ?"
```

显示所有信息，包括时间线事件：
```
mcp__sqlite__read_query:
  "SELECT * FROM timeline WHERE contact_id = ? ORDER BY created_at DESC LIMIT 10"
```

### 手动重新分类

当用户从主菜单中选择"手动重新分类"时：
1. 询问联系人的邮件地址
2. 查找联系人（与查看联系人状态相同的查询）
3. 显示当前状态
4. 询问要更改为什么状态（使用 AskUserQuestion，有效状态：INTERESTED、NOT_INTERESTED、HANDED_OVER、EXITED）
5. 更新 workflow_state 并记录时间线事件

### 将潜在客户交接给团队成员

当用户从主菜单中选择"将潜在客户交接给团队成员"时：

**步骤 H1：识别潜在客户**
1. 询问潜在客户的邮件地址。
2. 查找联系人（与查看联系人状态相同的查询）。
3. 显示当前状态、最近的时间线事件和邮件历史。

**步骤 H2：生成对话摘要**
阅读此联系人的所有时间线事件和 email_log 条目。以**配置的语言**生成结构化摘要：

```
--- 对话摘要 ---
联系人: {name}, {company}, {email}
当前状态: {state}

时间线:
• [日期] {event_type}: {description}
• [日期] {event_type}: {description}
...

关键讨论要点:
- {邮件交流中的要点 1}
- {邮件交流中的要点 2}

潜在客户意图: {interested / not_interested}
未解决的问题: {潜在客户提出的任何未回答问题}
建议人工下一步: {建议}
--- 摘要结束 ---
```

将此摘要作为 `conversation_summary` 存储在 handoffs 表中。

**步骤 H3：选择团队成员**
读取 `references/crm-settings.json` → `teamMembers`。通过 `AskUserQuestion` 显示为选项，显示每个成员的姓名和角色。

**步骤 H4：收集指示**
询问用户："对 {团队成员姓名} 有什么具体的指示或备注？"
这是自由文本，可选。默认为："请就 {他们的兴趣摘要} 与 {company} 的 {name} 跟进。联系方式：{email}。"

**步骤 H5：记录交接**
```
mcp__sqlite__write_query:
  "INSERT INTO handoffs (contact_id, assigned_to, assigned_email, status, conversation_summary, instructions)
   VALUES (?, ?, ?, 'pending', ?, ?)"
```

如果尚未 HANDED_OVER，更新工作流状态：
```
mcp__sqlite__write_query:
  "UPDATE workflow_state
   SET state = 'HANDED_OVER', last_action = '已交接给 {assigned_to}',
       state_entered_at = datetime('now'), updated_at = datetime('now')
   WHERE contact_id = ?"
```

记录时间线：
```
mcp__sqlite__write_query:
  "INSERT INTO timeline (contact_id, event_type, description)
   VALUES (?, 'handed_over', '已交接给 {assigned_to} ({assigned_email})。指示：{instructions}')"
```

**步骤 H6：确认**
显示：
```
✅ 交接已记录：
- 潜在客户: {name} ({email})
- 分配给: {团队成员姓名} ({email})
- 状态: 待处理
- 指示: {instructions}

⚠️ 提醒：通知 {团队成员姓名} 接管此潜在客户。上面的对话摘要可分享给他们以供参考。
```

**可选：发送通知邮件**
询问用户："向 {团队成员姓名} 发送包含对话摘要的通知邮件？"

如果是：
```
mcp__email__send_email:
  to: {团队成员的邮件}
  subject: "[CRM 交接] {name} @ {company} — {意图摘要}"
  body: {对话摘要 + 指示}
```
更新 handoff 状态为 `notified`。

返回主菜单。

### 设置/验证系统

当用户选择"设置/验证系统"时：
1. 检查数据库表是否存在：
   ```
   mcp__sqlite__list_tables
   ```
2. 如果缺少表，通过运行 `scripts/setup-db.js` 列表中的每个 CREATE TABLE 语句来创建它们。使用 `mcp__sqlite__create_table`（首选）或 `mcp__sqlite__write_query`。
3. 验证邮件连接：
   ```
   mcp__email__verify_connection
   ```
4. 报告："数据库：{OK 或表已创建}。SMTP：{OK/错误}。IMAP：{OK/错误}。"

---

## 关键规则

1. **始终在发送任何邮件（外展或自动回复）前展示草稿供人工批准。**
2. **创建新联系人前始终检查去重**（阶段 2.2）。
3. **始终在时间线表中记录每个操作。**
4. **永远不要向自动回复发送自动回复**——在阶段 5 中检测外出/自动回复器。
5. **优雅地处理错误**——如果邮件发送失败，在时间线中记录错误，提供重试选项。
6. **使用此技能 frontmatter 中的 `allowed-tools`**——所有列出的工具均已预先批准，不需要权限提示。
7. **所有邮件使用配置的语言**——检查 `crm-settings.json` 中的 `language`。
   `"en"`（默认）为英文，`"zh"` 为中文。
8. **在回复中始终包含引用的原始邮件**——每封自动回复（阶段 6）必须在你新的文本下方附加潜在客户的原始邮件作为引用块（`> ` 前缀）。收件人必须能够看到这是对哪段对话的回应。
9. **让用户了解情况**——始终显示发生了什么以及联系人处于什么状态。
10. **使用完全限定的 MCP 工具名称**——例如，`mcp__sqlite__write_query`，而不仅仅是 `write_query`。
11. **有疑问时询问用户**——尤其是在编辑草稿或处理边缘情况时。
12. **始终在发送冷外展邮件前调研潜在客户的公司网站**（步骤 3.1b）。使用 WebFetch 了解他们的行业、产品和市场定位。根据他们具体的业务画像定制产品推荐。
13. **在撰写回复前始终回顾对话历史**（步骤 6.0）。阅读至少最近 3 封邮件交流作为上下文。引用之前的讨论要点，匹配对话语气，并处理任何未解决的问题或待处理事项。
14. **交接后的回复仅记录不处理。** 当联系人处于 HANDED_OVER 状态时，任何后续回复
    （来自潜在客户或跟进人员）必须记录到 email_log 和时间线（event_type='reply_recorded'），
    但不得触发意图分类（阶段 5）或自动回复（阶段 6）。跟进人员正在手动处理此对话。
    不要更改工作流状态——保持为 HANDED_OVER。
