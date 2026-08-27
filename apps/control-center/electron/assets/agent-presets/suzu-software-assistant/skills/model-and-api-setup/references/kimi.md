# Kimi Code 与 Moonshot Kimi API

Kimi Code 会员 Key 与 Kimi 开放平台按量 API Key 使用不同地址。先根据用户购买或创建 Key 的平台选择。

## 主模型

- Kimi Code：工具厂商 ID `kimi`，地址 `https://api.kimi.com/coding`，默认模型 `kimi-for-coding`。
- Kimi 开放平台：工具厂商 ID `kimi-api`，地址 `https://api.moonshot.cn/v1`，默认模型 `kimi-k2.6`。
- 用户说“Moonshot”或“开放平台”时使用 `kimi-api`；用户说“Kimi Code”“会员 Coding”时使用 `kimi`。

## 独立 API 连接

- 工具厂商 ID：`moonshot`
- 预设地址：`https://api.moonshot.cn/v1`
- 连接类型：`openai-compatible`
- 默认模型按能力选择；普通文本或视觉理解可从当前开放平台模型中选择。

## 官方资料

- Kimi API 文档：https://platform.kimi.ai/docs/overview
- Kimi Code 帮助：https://www.kimi.ai/help/kimi-code/faq
- Kimi Code 配置：https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files
