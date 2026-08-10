# 企业微信（WeCom）集成设置指南

本文档指导如何在企业微信管理后台创建自建应用，以配合 cc-connect 实现 CRM 的 IM 通知和交互。

## 前置条件

- 企业微信管理员权限
- 已安装 cc-connect（`npm install -g cc-connect`）

## 步骤 1：创建自建应用

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 导航至：**应用管理** → **自建** → **创建应用**
3. 填写应用信息：
   - **应用名称**：`CRM助手`
   - **应用 logo**：上传合适的图标（建议 200×200 PNG）
   - **可见范围**：选择需要使用 CRM 助手的部门或人员
4. 点击「创建应用」

## 步骤 2：获取凭证

创建完成后，记录以下三个关键信息：

| 凭证 | 位置 | 环境变量 |
|------|------|---------|
| **Corp ID**（企业ID） | 「我的企业」→ 企业信息 → 企业ID | `WECOM_CORP_ID` |
| **Agent ID** | 应用详情页 → AgentId | `WECOM_AGENT_ID` |
| **Secret** | 应用详情页 → Secret（点击「查看」生成） | `WECOM_SECRET` |

> ⚠️ **Secret 只会显示一次**，请立即复制保存。如果丢失需要重新生成。

## 步骤 3：配置消息接收

1. 在应用详情页，找到「接收消息」区域
2. 点击「启用 API 接收消息」
3. **WebSocket 模式无需配置回调 URL 和 Token** — cc-connect 通过 WebSocket 长连接主动接收消息，不需要公网 IP 或回调地址
4. 保存设置

> ℹ️ 「企业可信 IP」配置在使用 WebSocket 模式下也无需填写。

## 步骤 4：白名单配置

企业微信机器人**没有**飞书那样的 HMAC 签名校验。安全依赖于 `allow_from` 白名单。

1. 在 cc-connect 的 `config.toml` 中配置 `allow_from`：
   ```toml
   allow_from = ["ZhangSan", "LiSi"]
   ```
2. 用户 ID 可以从企业微信通讯录中查看（英文 UserID）
3. 仅添加需要使用 CRM 助手的团队成员

## 步骤 5：设置环境变量

在终端配置文件（`~/.zshrc` 或 `~/.bashrc`）中添加：

```bash
export WECOM_CORP_ID="ww1234567890abcdef"
export WECOM_AGENT_ID="1000002"
export WECOM_SECRET="your-secret-here"
export WECOM_ALLOWED_USER_1="ZhangSan"
```

然后执行 `source ~/.zshrc`（或 `source ~/.bashrc`）使其生效。

## 步骤 6：启动 cc-connect

```bash
# 启动 cc-connect 守护进程
cc-connect serve --config ~/.cc-connect/config.toml

# 或在后台运行
nohup cc-connect serve --config ~/.cc-connect/config.toml > /tmp/cc-connect.log 2>&1 &
```

## 步骤 7：测试连通性

1. 在企业微信中找到「CRM助手」应用（通讯录 → 自建应用）
2. 发送消息「你好」
3. cc-connect 应收到消息并路由到 Claude Code 处理
4. 如果收到回复，说明配置成功

## 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 收不到消息 | cc-connect 未启动 | 检查进程：`ps aux \| grep cc-connect` |
| 消息无回复 | Claude Code 未正确响应 | 检查 cc-connect 日志 |
| WebSocket 断开 | 网络不稳定 | cc-connect 内置自动重连，检查网络状态 |
| 提示 token 无效 | Secret 错误或过期 | 在企业微信后台重新生成 Secret |
| Corp ID 无效 | 复制错误 | 确认从「我的企业」页面复制的完整 Corp ID |

## 相关文件

- `~/.cc-connect/config.toml` — cc-connect 配置（WeCom 平台 + Agent）
- `references/crm-settings.json` — CRM 中的 IM 通知开关和偏好设置
- `.claude/skills/card-followup/skill.md` — IM 推送通知的 Skill 逻辑
