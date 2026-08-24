---
name: image-generation
description: 通过 Suzu Lives 的图像引擎生成图片。
---

# Image Generation

执行稳定入口：

`suzu-lives image-generation --prompt "画面中实际需要生成的内容"`

手机拍照式画面与普通图片共用图像生成能力。Agent action 使用 `stylePreset: "phone-camera"`，并提供 `shot`（`rear`、`selfie` 或 `mirror`）与 `scene`；该路径读取图像生成设置中的画面预设。

可选 `--size WIDTHxHEIGHT`，以及重复的 `--ref [identity|location|object|style=]PATH`。请求协议和 API 由 Suzu Lives 的统一软件配置决定。

`--out` 必须位于当前 Agent 的 Suzu Lives 数据目录；`--config` 必须位于软件统一的 `capabilities/image-generation` 配置目录。图片 API 使用“设置 → API”里为“生图”选定的连接，不读取外部配置或凭据；模型与请求协议由该连接决定。成功 JSON 的 `status: "ok"` 才代表图片已保存。

生成后的 JSON 会给出本地图片路径。若用户要求交付，使用当前 Suzu 会话系统提示中提供的附件交付命令；它会显示在本会话中，并在该会话已绑定微信时自动发送。不要使用 `--send`，也不要自动导入视觉参考库或调用 image-vision；是否识图、保存为参考、或交付是独立后续动作。
