# Suzu Lives 架构

Suzu Lives 是一个本地优先的陪伴型 Agent 软件。产品界面、联系人、关系设定、模型连接、记忆、日历、能力、账本和数据管理都由 Suzu 自己实现；Agent 执行使用 Suzu Agent Core。

## 产品边界

```text
React 界面
  -> Electron preload / IPC
  -> Suzu 产品服务
       ├─ 联系人、SUZU.md、记忆、日历、附件、账本
       ├─ 能力注册、CLI / Skill / MCP 适配
       └─ Suzu Agent Runtime
            -> 私有 Node IPC 子进程
            -> 选定的开源执行源码（vendor）
```

Suzu Agent Runtime 不是完整的第三方应用：没有 Web 控制台、浏览器服务、上游 CLI 或外部 HTTP 端口。它仅复用必要的开源执行组件，并保留相应来源记录和许可证。

## 数据所有权

1. 安装目录只放程序和受管资源，不放用户聊天、密钥或长期数据。
2. Suzu 数据目录保存设置、联系人、附件、记忆、计划、能力配置与 Agent Core 的私有运行数据。
3. 联系人工作目录保存该关系的 `SUZU.md`、关系资料和用户明确要求的文件。
4. 删除联系人先停止其运行时写入者，再删除精确匹配的会话、未共享附件和联系人专属数据；不会越界删除用户自行保存到其他位置的文件。

## 能力与 Hook

能力声明、启用状态和 API 选择由 Suzu 管理。Agent Core 只会看到当前联系人已启用、且对应适配器实际存在的动作；新增功能不需要修改一份平行的工具名单。

`@suzu-lives/agent-lifecycle` 是正式 Hook 层。时间感知、记忆召回、日历等内容通过 `ContextCollect` 或 `DynamicContextCollect` 在真实模型请求前注入；动态资料在当前请求完成后从模型活动历史移除，但仍会保留产品侧可查询记录。

## 发布护栏

- 运行缓存优先放在 `D:\Temp`，不回落到 C 盘系统临时目录。
- 安装包中必须保留 vendor 的 NOTICE 与 MANIFEST。
- 安装包不得携带被排除的上游 Web / 工作流 / 代码运行时产品。
- 每次改动都验证聊天、历史、附件、压缩、Hook、能力和联系人删除。
