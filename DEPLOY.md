# CRM 项目服务器部署指南

本文档涵盖将 AI Email Outreach Mini-CRM 部署到 Linux 服务器的完整流程。

## 目录

1. [服务器要求](#1-服务器要求)
2. [环境安装](#2-环境安装)
3. [项目部署](#3-项目部署)
4. [凭证配置](#4-凭证配置)
5. [IM 集成 (cc-connect)](#5-im-集成-cc-connect)
6. [自动检查 (Cron)](#6-自动检查-cron)
7. [启动与验证](#7-启动与验证)
8. [Docker 部署 (可选)](#8-docker-部署-可选)
9. [运维手册](#9-运维手册)

---

## 1. 服务器要求

| 项目 | 最低要求 | 推荐 |
|------|---------|------|
| **操作系统** | Linux (Ubuntu 20.04+ / Debian 11+ / CentOS 8+) | Ubuntu 22.04 LTS |
| **CPU** | 2 核 | 4 核 |
| **内存** | 4 GB | 8 GB |
| **磁盘** | 20 GB | 50 GB |
| **网络** | 出站 HTTPS (443) 访问 | 无需公网 IP |
| **Node.js** | 18.x LTS | 20.x LTS |
| **额外工具** | git, curl, jq, sqlite3 | — |

> ℹ️ **不需要公网 IP**：cc-connect 使用 WebSocket 出站连接，无需配置回调 URL 或公网 IP。

---

## 2. 环境安装

### 2.1 安装 Node.js

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 或使用 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 20
nvm use 20
```

### 2.2 安装系统依赖

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y \
  git curl jq sqlite3 build-essential python3

# CentOS/RHEL
sudo dnf install -y git curl jq sqlite gcc-c++ python3
```

### 2.3 安装 Claude Code CLI

```bash
# 通过 npm 全局安装
npm install -g @anthropic-ai/claude-code

# 验证安装
claude --version
```

首次使用需要登录认证：

```bash
claude login
# 按提示完成 OAuth 或 API key 认证
```

### 2.4 安装 cc-connect

```bash
npm install -g cc-connect

# 验证安装
cc-connect --version
```

---

## 3. 项目部署

### 3.1 克隆项目

```bash
cd /opt
git clone https://github.com/Jiong1184/auto_send_mail.git
cd auto_send_mail
```

### 3.2 安装依赖

```bash
# 项目根目录依赖
npm install

# Email MCP Server 依赖
cd scripts/email-mcp-server && npm install && cd ../..
```

### 3.3 创建必要目录

```bash
mkdir -p data
  mkdir -p ~/.cc-connect/agent-prompts
```

### 3.4 初始化数据库

```bash
# 方式一：通过 Claude Code Skill
claude -p "run /card-followup and select Setup/verify system"

# 方式二：手动创建表
sqlite3 data/crm.db < scripts/setup-db.js 2>/dev/null || \
  node -e "require('./scripts/setup-db.js')" | sqlite3 data/crm.db
```

### 3.5 修改项目路径

**重要**：将以下文件中的本地路径替换为服务器路径。

**`scripts/auto-check.sh`：**

```bash
# 修改第 15 行和第 40 行
PROJECT_DIR="/opt/auto_send_mail"          # ← 你的部署路径
export HOME=/root                           # ← 部署用户的家目录
```

**`scripts/ocr.sh`：**

路径已自动检测（使用 `SCRIPT_DIR` 和 `PROJECT_DIR` 变量），无需修改。

---

## 4. 凭证配置

以下文件被 `.gitignore` 忽略，需要手动创建：

### 4.1 QQ 邮箱 SMTP/IMAP

```bash
cp scripts/email-mcp-server/config.example.json scripts/email-mcp-server/config.json
```

编辑 `scripts/email-mcp-server/config.json`：

```json
{
  "smtp": {
    "host": "smtp.exmail.qq.com",
    "port": 465,
    "secure": true,
    "auth": {
      "user": "sales6@zonade.cn",
      "pass": "你的QQ邮箱授权码"
    }
  },
  "imap": {
    "host": "imap.exmail.qq.com",
    "port": 993,
    "secure": true,
    "auth": {
      "user": "sales6@zonade.cn",
      "pass": "你的QQ邮箱授权码"
    }
  },
  "defaultFrom": "Ciel (Qian Qianqian) <sales6@zonade.cn>",
  "defaultReplyCheckDays": 7
}
```

### 4.2 MinerU OCR API Token

```bash
cp references/mineru/config.example.yaml references/mineru/config.yaml
```

编辑 `references/mineru/config.yaml`：

```yaml
token: sk-你的mineru-api-token
language: ch
```

> Token 获取：https://mineru.net/apiManage/token

### 4.3 设置文件权限

```bash
chmod 600 scripts/email-mcp-server/config.json
chmod 600 references/mineru/config.yaml
```

---

## 5. IM 集成 (cc-connect)

### 5.1 配置 cc-connect

创建 `~/.cc-connect/config.toml`：

```toml
language = "zh"

[[projects]]
name = "crm"
description = "AI Email Outreach Mini-CRM — ZONADE (佐奈丹箱包)"

[projects.agent]
type = "claudecode"

[projects.agent.options]
work_dir = "/opt/auto_send_mail"
mode = "default"

# 飞书 (Feishu) 平台
[[projects.platforms]]
type = "feishu"
name = "feishu-crm"

[projects.platforms.options]
app_id = "cli_xxx"
app_secret = "xxx"
connection_type = "websocket"
allow_from = ["ou_xxx"]

# 企业微信 (WeCom) — 可选
# [[projects.platforms]]
# type = "wecom"
# name = "wecom-crm"
#
# [projects.platforms.options]
# corp_id = "wwxxx"
# agent_id = "1000002"
# secret = "xxx"
# connection_type = "websocket"
# allow_from = ["ZhangSan"]
```

### 5.2 配置 cc-connect 为系统服务

创建 `/etc/systemd/system/cc-connect.service`：

```ini
[Unit]
Description=cc-connect IM Bridge Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/auto_send_mail
ExecStart=/root/.nvm/versions/node/v24.19.0/bin/node /root/.nvm/versions/node/v24.19.0/bin/cc-connect serve --config /root/.cc-connect/config.toml
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=/root/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin

# 安全加固
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/auto_send_mail/data
ReadWritePaths=/root/.cc-connect
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
  sudo systemctl enable cc-connect
  sudo systemctl start cc-connect
  sudo systemctl status cc-connect
```

---

## 6. 自动检查 (Cron)

### 6.1 修复 auto-check.sh

将 `scripts/auto-check.sh` 中的 macOS 特定部分改为 Linux 兼容：

```bash
# 第 28-36 行：将 stat -f%z 替换为 Linux 命令
# macOS 版本：
# LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)

# Linux 版本：
LOG_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
```

完整修改后的关键行：

```bash
PROJECT_DIR="/opt/auto_send_mail"          # ← 修改为部署路径
export HOME=/root                           # ← 修改为部署用户家目录
# ...
LOG_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)  # ← Linux stat 格式
```

设置权限：

```bash
chmod +x scripts/auto-check.sh
```

### 6.2 配置 Crontab

```bash
crontab -e
```

添加：

```cron
# CRM 自动回复检查 — 每 5 分钟一次
*/5 * * * * /opt/auto_send_mail/scripts/auto-check.sh
```

验证：

```bash
crontab -l
```

### 6.3 启用 CRM 自动轮询

运行 Claude Code 并开启自动轮询：

```bash
claude -p "/card-followup" 
# → 选择 "Toggle auto-polling" → Enable
```

这会在 `references/crm-settings.json` 中设置 `autoReplyPolling.enabled: true`。

---

## 7. 启动与验证

### 7.1 完整检查清单

```bash
# 1. 检查 Node.js
node --version     # v20.x

# 2. 检查 Claude Code
claude --version

# 3. 检查 cc-connect
cc-connect --version
systemctl status cc-connect

# 4. 检查依赖
cd /opt/auto_send_mail
npm ls --depth=0 2>/dev/null
cd scripts/email-mcp-server && npm ls --depth=0 2>/dev/null && cd ../..

# 5. 检查数据库
sqlite3 data/crm.db ".tables"
# 输出应包含: contacts, email_log, workflow_state, timeline, pending_approvals

# 6. 检查凭证
ls -la scripts/email-mcp-server/config.json
ls -la references/mineru/config.yaml

# 7. 检查 Cron
crontab -l | grep auto-check

# 8. 检查 cc-connect 日志
journalctl -u cc-connect -n 20 --no-pager
```

### 7.2 功能验证

```bash
# 1. 验证 Email MCP 连接
claude -p "verify email connection using the email MCP server"

# 2. 验证数据库
claude -p "query the crm database: SELECT count(*) FROM contacts"

# 3. 验证 IM 推送
claude -p "send a test IM message: cc-connect send --project crm -m '🚀 CRM 服务器部署完成！'"

# 4. 测试飞书入站
# 在飞书中 @CRM助手 发送「你好」，确认收到回复

# 5. 测试名片 OCR
# 在飞书中 @CRM助手 发送一张名片图片

# 6. 验证自动检查
tail -f data/auto-check.log
```

---

## 8. Docker 部署 (可选)

### 8.1 Dockerfile

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl sqlite3 python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# 安装 Claude Code
RUN npm install -g @anthropic-ai/claude-code

# 安装 cc-connect
RUN npm install -g cc-connect

# 创建部署用户
RUN useradd --create-home --shell /bin/bash crm
USER crm
WORKDIR /app

# 安装项目依赖
COPY --chown=crm:crm package*.json ./
RUN npm install

COPY --chown=crm:crm scripts/email-mcp-server/package*.json scripts/email-mcp-server/
RUN cd scripts/email-mcp-server && npm install

# 复制项目文件
COPY --chown=crm:crm . .

EXPOSE 9820
CMD ["cc-connect", "serve", "--config", "/home/crm/.cc-connect/config.toml"]
```

### 8.2 docker-compose.yml

```yaml
version: "3.8"

services:
  crm:
    build: .
    container_name: crm-auto-send-mail
    volumes:
      - ./data:/app/data
      - ./scripts/email-mcp-server/config.json:/app/scripts/email-mcp-server/config.json:ro
      - ./references/mineru/config.yaml:/app/references/mineru/config.yaml:ro
      - ./references/crm-settings.json:/app/references/crm-settings.json
      - crm_cc_config:/home/crm/.cc-connect
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "cc-connect", "--version"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  crm_cc_config:
```

启动：

```bash
# 先创建凭证文件
cp scripts/email-mcp-server/config.example.json scripts/email-mcp-server/config.json
cp references/mineru/config.example.yaml references/mineru/config.yaml
# 编辑凭证...

docker compose up -d
docker compose logs -f
```

---

## 9. 运维手册

### 9.1 日常监控

```bash
# cc-connect 状态
systemctl status cc-connect

# 查看最近日志
journalctl -u cc-connect --since "1 hour ago" --no-pager

# 自动检查日志
tail -50 /opt/auto_send_mail/data/auto-check.log

# 数据库状态
sqlite3 /opt/auto_send_mail/data/crm.db "SELECT state, count(*) FROM workflow_state GROUP BY state;"
```

### 9.2 重启服务

```bash
# 重启 cc-connect
sudo systemctl restart cc-connect

# 查看启动状态
sudo journalctl -u cc-connect -f
```

### 9.3 更新项目

```bash
cd /opt/auto_send_mail
git pull origin main
npm install
cd scripts/email-mcp-server && npm install && cd ../..

# 重启 cc-connect
sudo systemctl restart cc-connect
```

### 9.4 备份

```bash
# 备份数据库
cp data/crm.db data/crm.db.$(date +%Y%m%d_%H%M%S).bak

# 备份配置
tar czf crm-config-backup-$(date +%Y%m%d).tar.gz \
  scripts/email-mcp-server/config.json \
  references/mineru/config.yaml \
  references/crm-settings.json \
  ~/.cc-connect/config.toml

# 定期清理旧备份（保留最近 30 天）
find data/ -name "crm.db.*.bak" -mtime +30 -delete
```

### 9.5 故障排查

| 问题 | 检查 | 解决 |
|------|------|------|
| cc-connect 启动失败 | `journalctl -u cc-connect -n 50` | 检查 config.toml 语法，飞书凭证是否有效 |
| 自动检查不执行 | `crontab -l`，检查 `auto-check.log` | 确认 cron 路径和 `stat` 命令兼容性 |
| 飞书收不到推送 | `systemctl status cc-connect` | 重启 cc-connect，检查 WebSocket 连接 |
| 邮件发送失败 | Email MCP 连接测试 | 检查 QQ 邮箱授权码是否过期 |
| OCR 失败 | MinerU API 连通性 | 检查 token 是否有效，API 额度是否用尽 |
| 数据库锁定 | `fuser data/crm.db` | 检查是否有其他进程占用 |

### 9.6 安全建议

- 所有凭证文件权限设为 `600`
- 使用非 root 用户运行所有服务
- 定期轮换 QQ 邮箱授权码（90 天）
- 定期轮换 MinerU API Token
- 监控 `auto-check.log` 大小，确保日志轮转正常
- 飞书 App Secret 定期检查是否过期

#飞书
app_id = "cli_aaf0350294a1dbd4"
app_secret = "<your-feishu-app-secret>"
allow_from = ["<your-open-id>"]