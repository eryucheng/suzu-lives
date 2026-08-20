# Agent Registry

Suzu Lives 各模块共用的联系人身份和数据路径基础层。包名暂时保留为 `agent-registry`，但它不依赖任何外部 Agent 工作空间。

当前负责：

- 根据联系人目录或其保存的身份生成稳定 ID；
- 定位联系人在 Suzu Lives 数据目录中的专属目录；
- 定位联系人各个 Agent Core 会话的专属附件与产品数据目录。

本模块不读取人设、不把能力代码写入联系人目录，也不依赖 Electron。桌面端和软件能力共用同一份实现；聊天会话本身由 Suzu Agent Core 保存和读取。
