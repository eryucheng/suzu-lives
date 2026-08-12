---
name: image-generation
description: 通过 Suzu Lives 的图像引擎生成普通图片或明确指定的 ComfyUI 工作流图片。
---

# Image Generation

这不是 `phone-camera`：普通生成图片和明确指定的本地 ComfyUI 工作流使用此能力。执行稳定入口：

`suzu-lives image-generation --prompt "画面中实际需要生成的内容"`

可选 `--backend api|comfyui`、`--workflow <id>`、`--size WIDTHxHEIGHT`、`--seed <整数>`，以及重复的 `--ref [identity|location|object|style=]PATH`。默认后端来自 Suzu Lives 的统一软件配置；API 或 ComfyUI 出错时不能切换到另一后端。`--list-workflows` 与 `--validate-workflows` 只检查软件数据目录中的 ComfyUI registry，不会连接 ComfyUI。

`--out` 必须位于当前 Agent 的 Suzu Lives 数据目录；`--config` 必须位于软件统一的 `capabilities/image-generation` 配置目录。图片 API 使用软件保存的阿里百炼连接（或 `DASHSCOPE_API_KEY` 环境覆盖），不读取外部配置或凭据；无参考图使用 `z-image-turbo`，带参考图使用 `wan2.7-image`。成功 JSON 的 `status: "ok"` 才代表图片已保存。

生成后的 JSON 会给出本地图片路径。若用户要求交付，使用当前 Suzu 会话系统提示中提供的附件交付命令；它会显示在本会话中，并在该会话已绑定微信时自动发送。不要使用 `--send`，也不要自动导入视觉参考库或调用 image-vision；是否识图、保存为参考、或交付是独立后续动作。
