# 时间感知

在每次 Claude Code `UserPromptSubmit` 时读取电脑的当前本地时间，并通过 `additionalContext` 注入本轮上下文：

```text
你知道现在是7月17日 星期五 16:30。
```

如果当天命中了用户维护的节假日或纪念日，还会变成：

```text
你知道现在是10月1日 星期四 09:20。今天是国庆节，也是我们的纪念日。
```

它让 Agent 能直接判断当前日期、星期和分钟，不需要为了回答“几点了”额外调用命令。

## 工作方式

```text
用户消息进入 Claude Code
    ↓
UserPromptSubmit Hook 运行一次 timehook.mjs
    ↓
读取电脑当前本地时间
    ↓
分别匹配 holidays.json 和 calendar.local.json
    ↓
作为 additionalContext 注入本轮
    ↓
脚本立即退出
```

脚本不读取消息正文，不调用网络或模型，不需要 API Key，也不创建日志和运行状态。

## 法定节假日

`holidays.json` 随模块提供，保存公共节假日。当前预置日期固定的元旦、劳动节和国庆节，不需要用户先创建配置。

中国法定假期中的农历日期和调休安排每年都会变化，本模块不会联网猜测。春节、中秋、清明以及每年的放假和补班日期，应在官方安排公布后写成精确的 `YYYY-MM-DD` 条目。补班日可以把名称直接写成“春节调休补班日”，避免 Agent 把周末误判成休息日。

以后可以单独增加年度更新脚本，但不需要改变时间 Hook 本身。

## 私人日期

生日、纪念日和个人安排不写入公共的 `holidays.json`。需要使用时，把同目录的：

```text
calendar.local.example.json
```

复制一份并改名为：

```text
calendar.local.json
```

然后编辑其中的 `events` 列表。日期支持两种写法：

- `MM-DD`：每年重复，适合固定节日、生日和纪念日。
- `YYYY-MM-DD`：只在这一天命中，适合当年的调休、行程和一次性事件。

每项的 `name` 是注入给 Agent 的名称；`type` 只用于在配置中分类，不会进入对话上下文；暂时不想启用时可加 `"enabled": false`。同一天可以写多项，Hook 会自然合并成“今天是……，也是……”一句话。

`calendar.local.json` 已被模块内的 `.gitignore` 排除，私人纪念日不会因为正常提交代码而进入 Git 仓库。私人文件不存在或格式错误时，Hook 仍会继续读取公共节假日，也不会阻断聊天。

## 安装

如果要同时启用 RAG 和微信分条，可以直接使用仓库的[整套安装配置](../../../integrations/README.md)。以下步骤用于单独安装时间感知。

把 `settings.example.json` 里的 `UserPromptSubmit` 条目合并到项目的：

```text
项目目录/.claude/settings.json
```

如果已经安装 RAG 等其他 `UserPromptSubmit` Hook，应在同一个数组中追加本条，不要覆盖原有条目。`${CLAUDE_PROJECT_DIR}` 会自动指向当前 Agent 项目，不需要写死用户名或绝对路径。

重新启动对应的 Claude Code Agent 进程后生效。

## 时间来源

日期、星期和时间都来自运行 Claude Code 的电脑当前时区。需要改变时区时修改操作系统时区即可，模块本身不保存时区配置。

## 与记忆系统配合

时间注入在 Claude Code JSONL 中属于 `hook_additional_context` 附件，不是用户或助手说过的话。Suzu Lives 的压缩器和 RAG 只归档双方可见文本，不会把这些每轮变化的当前时间当成历史记忆。

如果配合其他记忆系统使用，也应排除 `hook_additional_context`，避免以后询问当前时间时召回旧时间。

## 定时任务

只要定时任务最终向 Claude Code 提交一次用户提示，就会经过本 Hook 并获得触发当时的时间。只执行外部命令、完全不调用 Agent 的 `--exec` 任务不会触发 Claude Code Hook。
