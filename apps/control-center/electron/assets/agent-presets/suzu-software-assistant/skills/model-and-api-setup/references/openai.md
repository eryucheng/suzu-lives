# OpenAI

## 主模型

- 工具厂商 ID：`openai`
- Suzu 地址：`https://api.openai.com/v1`
- Suzu 协议：`openai-responses`
- Suzu 默认模型：`gpt-5.6`
- 用户指定具体模型时使用其模型标识；仅提供 OpenAI API Key 且用途是主模型时，可使用 Suzu 默认模型保存。

## 独立 API 连接

- 工具厂商 ID：`openai`
- 预设地址：`https://api.openai.com/v1`
- 连接类型：`openai-compatible`
- 默认模型依据能力选择，例如文本与视觉理解使用相应文本模型，图片生成使用相应图像模型。用户只说“OpenAI API”时，先确认准备给哪项能力使用。

## 官方资料

- 模型目录：https://developers.openai.com/api/docs/models
- API 参考：https://developers.openai.com/api/reference
