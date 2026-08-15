# @suzu-memory/providers

Suzu Memory 的外部模型协议适配层。

当前统一提供：

- OpenAI Compatible 结构化生成；
- Anthropic Compatible Messages 结构化生成；
- OpenAI Compatible Embedding；
- DashScope 配置别名；传入旧的 `https://dashscope.aliyuncs.com/api/v1` 时，生成与 Embedding 都会规范化到官方 OpenAI 兼容地址 `compatible-mode/v1`；
- 一次性 Claude CLI 结构化生成。

Provider 只处理请求、响应、结构化输出、错误和用量信封，不读取数据库、不决定记忆内容，也不执行召回规则。Config 是组合根，负责把选定 Provider 注入 Service 和领域流水线。

结构化生成默认对网络错误、请求超时、HTTP 408/425/429/5xx，以及“HTTP 成功但响应外壳不是 JSON”的传输故障最多尝试三次。模型已经返回合法响应外壳后，内容缺失、工具名错误或领域 Schema 不通过不属于传输重试，继续交给上层专职分析与审核机制。失败诊断只记录状态码、Content-Type、响应字符数和请求 ID，不保存可能含有私密内容的响应正文。可用 `maximumTransportAttempts`（1～5）与 `transportRetryDelayMs`（0～30000）调整。
