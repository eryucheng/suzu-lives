# 阿里云百炼、通义与 DashScope

先确认 API Key 属于按量付费、Coding Plan、Token Plan、地域或业务空间。API Key 与接入地址需要来自同一方案。

## 主模型

- 百炼 Coding Plan：工具厂商 ID `bailian-coding`，Suzu 地址 `https://coding.dashscope.aliyuncs.com/apps/anthropic`，默认模型 `qwen3.8-max-preview`。
- 百炼按量付费：工具厂商 ID `bailian-payg`，Suzu 地址 `https://dashscope.aliyuncs.com/apps/anthropic`，默认模型 `qwen3.8-max`。
- 用户说“通义”“DashScope”或“百炼”且确认是普通按量 Key 时，使用 `bailian-payg`。Coding Plan Key 使用 `bailian-coding`。

## 独立 API 连接

- 通义 OpenAI 兼容模式：工具厂商 ID `tongyi`，地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`，连接类型 `openai-compatible`。
- DashScope 原生接口：工具厂商 ID `dashscope`，地址 `https://dashscope.aliyuncs.com/api/v1`，连接类型 `dashscope`。
- 默认模型按能力选择；长期记忆向量通常由能力设置使用 `text-embedding-v4`。

## 官方资料

- Base URL 总览：https://help.aliyun.com/zh/model-studio/base-url
- 获取与配置 API Key：https://help.aliyun.com/zh/model-studio/get-api-key/
- 模型列表：https://help.aliyun.com/zh/model-studio/getting-started/models
