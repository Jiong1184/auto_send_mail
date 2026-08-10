# 飞书（Feishu/Lark）集成设置指南

本文档指导如何在飞书开放平台创建企业自建应用，以配合 cc-connect 实现 CRM 的 IM 通知和交互。

## 前置条件

- 飞书管理员权限
- 已安装 cc-connect（`npm install -g cc-connect`）

## 步骤 1：创建企业自建应用

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 填写应用信息：
   - **应用名称**：`CRM助手`
   - **应用描述**：AI 邮件外展 CRM 的 IM 通知和交互通道
   - **应用 logo**：上传合适的图标（建议 200×200 PNG）
4. 点击「确认创建」

## 步骤 2：添加机器人能力

1. 在应用详情页，左侧导航 →「添加应用能力」
2. 选择「机器人」→ 开启
3. 配置机器人基本信息（名称、描述等）

## 步骤 3：配置权限

在应用详情页 →「权限管理」，添加以下权限：

| 权限 | 用途 |
|------|------|
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:message` | 获取机器人接收的消息 |
| `im:message:patch_as_bot` | 编辑机器人发送的消息 |
| `im:resource` | 获取消息中的资源（图片、文件等） |

> 以上权限需要管理员审批。如果是企业内部应用，通常在创建时自动授权。

## 步骤 4：选择 WebSocket 连接模式

在应用详情页 →「事件订阅」：

1. 切换为 **WebSocket 模式**（无需配置回调 URL）
2. 订阅事件：**`im.message.receive_v1`**（接收消息）
3. 保存

> ℹ️ **WebSocket 模式的优势**：无需公网 IP 或域名，cc-connect 主动出站连接到飞书服务器。

## 步骤 5：获取凭证

1. 在应用详情页 →「凭证与基础信息」，记录：
   - **App ID** → 环境变量 `FEISHU_APP_ID`
   - **App Secret** → 环境变量 `FEISHU_SECRET`（注意：cc-connect 使用 `app_secret` 字段名，但部分文档使用 `FEISHU_SECRET`）

2. ⚠️ **App Secret 仅在创建时显示一次**，请立即复制保存。

## 步骤 6：发布应用

1. 在应用详情页 →「版本管理与发布」
2. 创建新版本 → 填写版本号和更新说明
3. 提交审核 → 审批通过后发布
4. **发布后应用才能被企业中其他成员使用**

## 步骤 7：设置环境变量

在终端配置文件（`~/.zshrc` 或 `~/.bashrc`）中添加：

```bash
# 飞书 (Feishu)
export FEISHU_APP_ID="cli_xxx"
export FEISHU_SECRET="xxxxx"
export FEISHU_ALLOW_USERS='["xxxx"]'
```

然后执行 `source ~/.zshrc`（或 `source ~/.bashrc`）使其生效。

### 如何获取 open_id

`open_id` 是飞书应用内的用户唯一标识，格式为 `ou_xxxxxxxxxxxxx`。获取方式：

**方式一：API 调试（推荐，最快）**

1. 登录 [飞书开放平台](https://open.feishu.cn/app) → 进入你的应用
2. 左侧导航 → **API 调试**
3. 选择 **通讯录** → **获取用户列表** → `GET /open-apis/contact/v3/users`
4. 点击「发送请求」→ 返回的 JSON 中每个用户的 `open_id` 即为所需值

**方式二：curl 命令行**

```bash
# 1. 获取 tenant_access_token
TOKEN=$(curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_SECRET\"}" | jq -r '.tenant_access_token')

# 2. 获取用户列表（含 open_id）
curl -s 'https://open.feishu.cn/open-apis/contact/v3/users?page_size=50' \
  -H "Authorization: Bearer $TOKEN" | jq '.data.items[] | {name: .name, open_id: .open_id}'
```

**方式三：飞书管理后台**

1. 登录 [飞书管理后台](https://admin.feishu.cn)
2. **通讯录** → **成员与部门** → 点击具体成员
3. 成员详情页中查看 **open_id**（注意：部分版本不直接显示）

> 💡 **提示**：`allow_from` 是可选但推荐的安全配置。如果不配置（留空数组 `[]`），则所有企业成员都可以使用该机器人。飞书有 HMAC 签名校验兜底，安全性比企微更好。

## 步骤 8：配置 cc-connect

在 `~/.cc-connect/config.toml` 中已有 WeCom 平台配置的基础上，追加飞书平台块：

```toml
# 飞书 (Feishu) 平台
[[projects.platforms]]
type = "feishu"
name = "feishu-crm"

[projects.platforms.options]
app_id = "${FEISHU_APP_ID}"
app_secret = "${FEISHU_SECRET}"
connection_type = "websocket"
# 飞书有 HMAC 签名校验，allow_from 可选但推荐配置
allow_from = ${FEISHU_ALLOW_USERS}
```

> 🔒 **安全说明**：飞书自带 HMAC 签名校验（比企微更安全），但 `allow_from` 白名单仍然建议配置。格式为 `open_id` 数组（如 `["ou_xxx","ou_yyy"]`）。用户 `open_id` 可在飞书管理后台的「通讯录」中查看。

## 步骤 9：重启 cc-connect 并测试

```bash
# 停止旧的 cc-connect 进程
pkill cc-connect

# 重新启动（加载新配置）
cc-connect serve --config ~/.cc-connect/config.toml
```

**测试连通性：**

1. 在飞书中找到「CRM助手」机器人
2. 发送「你好」
3. cc-connect 应收到消息并路由到 Claude Code 处理
4. 如果收到回复，说明飞书配置成功

## 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 收不到消息 | 应用未发布 | 在飞书开放平台发布应用 |
| WebSocket 连接失败 | App ID/Secret 错误 | 检查凭证是否正确复制 |
| 消息无回复 | Claude Code 未响应 | 检查 cc-connect 日志 |
| 权限不足 | 未添加必要权限 | 在权限管理中添加并重新审批 |
| HMAC 校验失败 | 飞书端开启了签名校验 | cc-connect WebSocket 模式自动处理 |

## 相关文件

- `~/.cc-connect/config.toml` — cc-connect 配置（飞书平台块）
- `references/crm-settings.json` — CRM 中的 IM 通知开关和平台列表
- `references/wecom-setup.md` — 企业微信设置指南（并行平台）
- `.claude/skills/card-followup/skill.md` — IM 推送通知的 Skill 逻辑
