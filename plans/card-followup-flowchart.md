# card-followup Skill 流程图

> 根据 `.claude/skills/card-followup/skill.md` 梳理的完整流程。
> 更新时间：2026-08-13

## 总览流程图

```mermaid
flowchart TD
    START([用户发起请求]) --> P0{阶段0<br/>IM 会话检测}

    P0 -->|图片消息<br/>[Image saved at:| IMG[IM 入站处理<br/>im-inbound-processor]
    P0 -->|批准/拒绝文本| APPR[审批处理<br/>pending_approvals]
    P0 -->|IM 其他文本| IMOTHER[直接理解意图执行<br/>cc-connect send + NO_REPLY]
    P0 -->|终端会话| P1

    IMG --> END0([结束])
    APPR --> END0
    IMOTHER --> END0

    P1[阶段1: 主菜单<br/>AskUserQuestion] --> MENU{选择操作}
    MENU -->|输入新名片| P2
    MENU -->|检查回复| P4
    MENU -->|查看状态| VIEW[查看联系人状态]
    MENU -->|交接| HANDOFF[交接给团队]
    MENU -->|设置/验证| SETUP[设置系统]
    MENU -->|切换开关| TOGGLE[翻转配置]

    P2[阶段2: 名片输入与去重] --> DEDUP{联系人已存在?}
    DEDUP -->|是| EXISTS[更新备注/看历史/返回]
    DEDUP -->|否| CREATE[创建联系人<br/>+workflow_state+timeline]
    EXISTS --> END1([返回主菜单])
    CREATE --> TZ[检测时区]

    TZ --> P3[阶段3: AI分析与生成邮件]
    P3 --> GEN[调研网站+读KB<br/>生成个性化草稿]
    GEN --> APPROVE{autoApproveDrafts?}
    APPROVE -->|true| AUTO_SEND[直接发送]
    APPROVE -->|false| REVIEW[人工审批草稿]
    REVIEW -->|取消| END2([存草稿返回])
    REVIEW -->|编辑| REVIEW
    REVIEW -->|发送| WORKHOURS{工作时间检查}

    AUTO_SEND --> WORKHOURS
    WORKHOURS -->|工作时间内| SEND[发送邮件]
    WORKHOURS -->|工作时间外| SCHEDULE[定时发送]
    SEND --> LOG3[记录email_log+状态]
    SCHEDULE --> END3([结束-等待定时])
    LOG3 --> END3

    P4[阶段4: 回复检查] --> P4_DETAIL[三级匹配详情]
    P4_DETAIL --> P5[阶段5: 意图分类]
    P5 --> INTENT{意图?}
    INTENT -->|NOT_INTERESTED| END4([结束])
    INTENT -->|INTERESTED| LIMIT{自动回复限制<br/>>=3?}
    LIMIT -->|是-同话题| HANDOVER4[转人工HANDED_OVER]
    LIMIT -->|否/新话题| P6[阶段6: 自动回复]
    HANDOVER4 --> END4
    P6 --> COMPOSE[回顾历史+读KB<br/>撰写回复+引用原文]
    COMPOSE --> SEND6[发送自动回复]
    SEND6 --> HANDOVER6[状态→HANDED_OVER<br/>需人工跟进物流]
    HANDOVER6 --> END4

    VIEW --> END1
    HANDOFF --> END1
    SETUP --> END1
    TOGGLE --> P1
```

## 阶段 4 详图：三级回复匹配

```mermaid
flowchart TD
    P4S[阶段4 开始] --> CLEAN[清理过期审批]
    CLEAN --> MODE{模式?}

    MODE -->|cron自动检查| SUB[派生子代理<br/>隔离上下文处理]
    SUB --> END0([返回1行摘要])

    MODE -->|手动| INBOX[4.1 检查收件箱<br/>IMAP轮询7天]
    INBOX --> NOMSG{有新邮件?}
    NOMSG -->|无| END1([返回主菜单])
    NOMSG -->|有| FILTER[过滤系统通知<br/>阿里云/腾讯/退信]

    FILTER --> T1{第一级<br/>Message-ID线程匹配?}
    T1 -->|命中| RECORD1[记录回复<br/>→阶段5]
    T1 -->|未命中| T2{第二级<br/>发件人邮箱匹配?}

    T2 -->|命中| RECORD2[记录回复<br/>→阶段5]
    T2 -->|未命中| T3[第三级: 冷入站<br/>自动创建联系人]
    T3 --> RECORD3[记录+通知<br/>→阶段5]

    RECORD1 --> STATE{检查联系人状态}
    RECORD2 --> STATE
    RECORD3 --> STATE

    STATE -->|HANDED_OVER| RECONLY[仅记录不处理<br/>event=reply_recorded]
    STATE -->|NOT_INTERESTED/EXITED| SKIP[完全跳过]
    STATE -->|其他| P5[→阶段5 意图分类]
    RECONLY --> END2([继续下一封])
    SKIP --> END2
```

## 阶段 5-6 详图：意图分类与自动回复

```mermaid
flowchart TD
    P5S[阶段5 开始] --> OOO{自动回复/外出检测?}
    OOO -->|是| NOTI[分类NOT_INTERESTED<br/>不自动回复]
    OOO -->|否| SEMANTIC[AI语义分析意图]

    SEMANTIC --> LOOP{回复循环检测?}
    LOOP -->|是| NOTI
    LOOP -->|否| CLASSIFY{意图分类}

    CLASSIFY -->|NOT_INTERESTED| END1([结束])
    CLASSIFY -->|INTERESTED| COUNT[统计已发自动回复数]

    COUNT --> LIMIT{count >= 3?}
    LIMIT -->|是| TOPIC{新话题?}
    TOPIC -->|否-同话题| HUMAN[转人工<br/>HANDED_OVER]
    TOPIC -->|是-新话题| RESET[重置计数<br/>继续]
    LIMIT -->|否| CONTINUE[继续自动回复]

    RESET --> P6
    CONTINUE --> P6
    HUMAN --> END1

    P6[阶段6 开始] --> HIST[6.0 回顾对话历史<br/>最近3封]
    HIST --> KB[6.1 调研/搜索KB]
    KB --> WRITE[6.2 撰写回复<br/>回答所有问题<br/>+引用原文]
    WRITE --> CHECK[自检: 引用/回答/语气]
    CHECK --> SEND[6.4 发送]
    SEND --> SUCCESS{发送成功?}

    SUCCESS -->|是| DONE[状态→HANDED_OVER<br/>记录email_log+timeline]
    SUCCESS -->|否| RETRY[重试 retry_count+1]
    RETRY --> RETRY3{retry>=3?}
    RETRY3 -->|否| KEEP[保持INTERESTED<br/>下轮重试]
    RETRY3 -->|是| GIVEUP[放弃→HANDED_OVER<br/>需人工]
    DONE --> END2([结束])
    KEEP --> END2
    GIVEUP --> END2
```

## 待确认的问题

1. **阶段 3 工作时间检查**：外展邮件要检查，回复邮件跳过。自动批准（AUTO_SEND）路径也走到了工作时间检查，符合预期吗？
2. **阶段 4 三级匹配兜底**：三级全失败（解析不出发件人邮箱）时「显示并跳过」，不创建联系人。
3. **阶段 5 安全阀顺序**：回复循环检测 和 自动回复限制（>=3）是串行执行（先循环检测后计数），实际执行顺序是否一致？
4. **冷入站**：第三级创建的联系人直接进阶段 5 分类，不先走去重。
