# Agent Registry

Suzu Lives 各模块共用的 Claude 项目身份和路径基础层。包名暂时保留为 `agent-registry`，但它不要求用户拥有任何旧 Agent 工作空间。

当前负责：

- 根据用户连接的 Claude 项目绝对路径生成稳定 ID；
- 定位该项目在 Suzu Lives 数据目录中的专属目录；
- 从当前联系人的原生 Claude 项目目录定位会话 JSONL。

本模块不读取人设、不把能力代码写入用户项目，也不依赖 Electron。桌面端和软件能力共用同一份实现；Claude 项目仅保存由软件管理的轻量注册文件。
