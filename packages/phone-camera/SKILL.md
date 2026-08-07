---
name: phone-camera
description: 让 Agent 通过 Suzu Lives 的图像引擎生成真实手机随手拍、自拍或镜面自拍。
---

# Phone Camera

先选择拍摄方式：食物、房间、街景和眼前所见用 `rear`；正面自拍用 `selfie`；穿搭或全身镜前照用 `mirror`。只把画面中真正可见的事实放进 `--scene`，不要重复相机或画质提示词。

使用稳定薄入口：

`suzu-lives phone-camera --shot rear --scene "画面中实际可见的场景" --dry-run`

需要视觉参考时使用重复的 `--ref <asset-or-set-id>`；只选择当前画面必要的资料。`--backend comfyui --workflow <id>` 只在明确指定本地工作流时使用；失败不会切回 API。成功 JSON 的 `status: "ok"` 才代表生成成功。

生成后的 JSON 会给出本地图片路径。若用户要求交付，使用当前 Suzu 会话系统提示中提供的附件交付命令；它会显示在本会话中，并在该会话已绑定微信时自动发送。不要使用 `--send`。
