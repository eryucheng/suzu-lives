---
name: image-generation
description: 通过 Suzu Lives 的图像引擎生成图片。
---

# 图像生成

普通图片：

`suzu-lives image-generation --prompt "画面内容"`

参考图使用重复的 `--ref [identity|location|object|style=]PATH`。用户要求参考当前聊天图片时，将附件路径作为 `--ref` 传入。

已有视觉资料可能影响画面时，先读取当前 `suzu-image-generation` 产品 Skill 给出的视觉参考注册表，再根据其中的角色和描述判断是否使用、选哪项。

手机拍照式画面使用：

`{ stylePreset: "phone-camera", shot: "rear" | "selfie" | "mirror", scene: "画面内容", references?: [{ scope: "contact" | "shared", id: "资料或分组 ID" }] }`

自拍或镜前照会自动附带当前联系人的 `identity` 参考图。场景、物品和风格参考按本次画面从可用资料中选择后传入。
