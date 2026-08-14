# Agent image generation

此包提供软件拥有的 Agent `image-generation` 命令，并复用 `@suzu-lives/image-workbench` 的实际 API/编辑和 ComfyUI 执行器。它不修改人工“创作 → 绘画”工作台。

运行记录和图片仅写入当前 Agent 的 `<dataRoot>/agents/<agent>/image-generation/`，API 使用成功时把用量事件写入同一 Agent 的 `cost-ledger/events.jsonl`。配置和 ComfyUI registry 位于统一的 `<dataRoot>/capabilities/image-generation/`；`--out` 仍受限于当前 Agent 数据目录。API Key 始终来自现有软件连接或环境覆盖。

`comfyui.registry` 使用 `file`、`bindings`、`defaults`、`reference_slots`、`output_nodes` 结构，并在执行前转换并验证为现有 image-workbench 的 API Format registry。生成后的图片由当前 Suzu 会话的附件交付命令接管：它会保存在会话缓存中，并在该会话已绑定微信时自动发送。
