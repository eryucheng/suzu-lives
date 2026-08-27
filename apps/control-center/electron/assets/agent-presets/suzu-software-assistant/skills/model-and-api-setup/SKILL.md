---
name: model-and-api-setup
description: 当用户要查看、填写或更换 Suzu Lives 的主模型、API Key、API 连接或模型服务参数时使用。
---

# 主模型与 API 连接

先判断 API Key 的用途：

- **主模型**用于联系人聊天和“问 Suzu”的文本回复，入口是“设置 → 主模型”。
- **API 连接**供图像、视频、语音等能力按名称选用，入口是“设置 → API”。

用途已经明确时直接完成配置。用途会改变保存位置时，用一句具体问题确认是“主模型”还是哪项能力使用的 API。

## 主模型

`suzu_main_model_status` 读取当前厂商、模型和连接状态。`suzu_main_model_save` 保存连接；用户给出已收录厂商和 API Key 时，厂商默认地址、协议和模型由软件补齐。用户指定模型、地址或协议时，以用户给出的值保存。

## API 连接

`suzu_api_connection_search` 查找已保存的连接。`suzu_api_connection_save` 新建或更新连接；已收录厂商会自动补服务类型和官方地址。更新现有连接时使用查询返回的 `connectionId`。备注省略时使用厂商名称。

OpenAI 兼容和 ASR 连接需要默认模型。用户说明了用途且厂商参考里有明确适配模型时可以直接填写；用途或模型仍不明确时，询问准备使用的能力或模型标识。

## 厂商资料

只读取当前厂商对应的参考：

- DeepSeek：[references/deepseek.md](references/deepseek.md)
- MiniMax：[references/minimax.md](references/minimax.md)
- 阿里云百炼、通义与 DashScope：[references/alibaba-cloud.md](references/alibaba-cloud.md)
- Kimi Code 与 Moonshot Kimi API：[references/kimi.md](references/kimi.md)
- OpenAI：[references/openai.md](references/openai.md)
- 智谱 GLM：[references/zhipu.md](references/zhipu.md)
- Ollama：[references/ollama.md](references/ollama.md)
- 自定义兼容服务、TTS 与 ASR：[references/custom-services.md](references/custom-services.md)

内置资料没有覆盖所需字段，或厂商规则可能已经更新时，再按 [references/online-lookup.md](references/online-lookup.md) 查厂商官网。

以工具返回的 `status` 和公开字段判断是否保存成功。回复中给出保存位置、厂商、连接备注和模型；API Key 作为本机配置输入使用。
