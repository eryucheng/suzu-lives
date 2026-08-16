# Suzu Lives Console

Suzu Lives 的本地桌面端。它管理联系人 Agent 的独立工作目录、Claude Code 会话、会话设置、软件能力、连接配置和本地用量记录。

## 当前功能

- 在桌面端创建、选择联系人，并为每个联系人使用独立的 Agent 工作目录；
- 读取并驱动当前联系人的 Claude Code 会话，支持普通消息、排队消息、停止与引导；
- 配置软件能力、模型/API 连接、微信会话绑定和本地媒体交付；
- 查看软件与 Claude 会话的用量和价格历史。

## 本地开发

请在仓库根目录执行 workspace 命令：

```powershell
cd <Suzu-Lives-仓库根目录>
npm install
npm run start --workspace=suzu-lives-console
```

默认 Claude Code 已由用户自行安装。首次打开时选择联系人 Agent 的工作目录；会话记录从该联系人的 Claude 官方目录自动识别。

## 验证与打包

```powershell
npm test
npm run dist
```

构建目标是 Windows ZIP，输出在 `apps/control-center/dist/`。解压 ZIP 后运行其中的 `Suzu Lives Console.exe`；目标电脑无需另装 Node.js 或 Electron。
