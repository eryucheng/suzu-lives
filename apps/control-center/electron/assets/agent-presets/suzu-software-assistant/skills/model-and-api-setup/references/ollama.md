# Ollama

## 使用条件

Ollama 是本机服务。先确认 Ollama 已运行，并取得用户本机已安装的模型标识；可通过 `ollama list` 查看。

## 主模型

- 工具厂商 ID：`ollama`
- Suzu 地址：`http://127.0.0.1:11434/v1`
- Suzu 协议：`openai-completions`
- 模型取自 `ollama list`，需要用户选择或根据明确用途选择已安装模型。

## 独立 API 连接

- 工具厂商 ID：`ollama`
- 预设地址：`http://127.0.0.1:11434/v1`
- 连接类型：`openai-compatible`
- 模型必须是本机已安装模型。Suzu 会使用兼容客户端所需的本地占位凭据保存连接。

## 官方资料

- OpenAI 兼容接口：https://docs.ollama.com/api/openai-compatibility
- API 文档：https://docs.ollama.com/api
