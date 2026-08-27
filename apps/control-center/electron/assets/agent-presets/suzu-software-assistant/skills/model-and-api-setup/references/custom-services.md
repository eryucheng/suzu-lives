# 自定义兼容服务、TTS 与 ASR

## 自定义主模型

使用工具厂商 ID `custom`。需要：

- 完整 Base URL；公网使用 HTTPS，本机地址可使用 HTTP。
- 模型标识。
- 协议：`openai-completions`、`openai-responses` 或 `anthropic-messages`。
- API Key，以及便于识别的服务名称。
- 模型支持图片输入时填写 `supportsImageInput`。

## 自定义 API 连接

- OpenAI 兼容服务：`custom-openai`，需要 Base URL、默认模型和 API Key。
- TTS：`tts-api`，需要连接备注和 API Key；音色与具体模型可由语音服务配置提供。
- ASR：`asr-api`，需要完整服务地址、默认识别模型和 API Key。
- 其他 HTTP API：`generic-api`，服务地址和默认模型可按适配器要求填写。

用户给出的厂商名称、Key 来源或套餐会影响地址时，先确认该字段，再保存到对应目标。
