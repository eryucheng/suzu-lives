---
name: phone-camera
description: 让 Agent 用图像生成接口像拿手机拍照一样分享现实感画面。用户要求拍照、自拍、镜面自拍、展示穿搭、看看眼前的食物或风景，或者 Agent 想主动用一张随手拍分享当前场景和找话题时使用。
---

# Phone Camera

先判断拍摄方式，再把画面中真正可见的内容交给脚本。默认使用 API，不要自己重复编写相机、画质和负向提示词。

## 选择拍摄方式

- 食物、物品、房间、街景、眼前所见：`rear`
- 正面脸部、半身、直接自拍：`selfie`
- 穿搭、全身照、明确对着镜子拍：`mirror`

用户没有指定方式时，依据想展示的内容直接选择；只有选择会实质改变用户需求时才追问。

## 调用

在项目根目录运行：

```powershell
python scripts/abilities/phone-camera/take_photo.py --shot rear --scene "画面中实际可见的场景" --send
```

把 `rear` 换成需要的方式。`--scene` 使用一两句具体视觉事实，包含必要的人物动作、表情、穿着、环境和光线；不要写关系解释、内心独白、画质标签或“像手机拍的”之类脚本已经负责的内容。

正常聊天中需要把图片交给用户时使用 `--send`。只想先生成到本地检查时不加。脚本输出 `status: ok` 才表示生成成功；`sent: true` 才表示已经交给 cc-connect。失败时如实说明 `PHOTO_ERROR`，不要假装已经拍到或发出。

用户明确要求本地模型或 ComfyUI 时，先用统一图像引擎列出已启用工作流：

```powershell
python scripts/abilities/image-generation/generate_image.py --list-workflows
```

存在匹配的手机照片工作流时，在原拍照命令后加 `--backend comfyui --workflow "workflow-id"`。没有匹配项时说明尚未配置，不能静默改用 API，也不能临时猜测节点参数。

## 使用已有视觉参考

当画面涉及应该保持稳定的人物、房间、物品或风格时，先用具体关键词搜索参考库：

```powershell
python scripts/abilities/phone-camera/manage_references.py list --query "卧室" --limit 10
```

选择本次画面真正需要的少量 asset 或 set，在命令中重复使用 `--ref`：

```powershell
python scripts/abilities/phone-camera/take_photo.py --shot mirror --scene "出门前在卧室穿衣镜前看今天的日常穿搭" --ref character-main --ref home-bedroom --send
```

没有相关命中时直接无参考生成，不要强行套用无关图片。不要一次把整个图库都传给 API；人物身份、所在空间和画面中的关键物品分别按需选择。用户明确要求保存、登记、修改或删除参考图时，改用 `visual-reference-manager` Skill；普通聊天附件绝不自动入库。

## 边界

- 参考图能提高人物与空间一致性，但不能保证像素级复刻；不要声称已经绝对锁定人物。
- 不把用户未要求的陌生人、手机、镜子或第三人摄影者写进场景。
- 不为每张生成图自动调用识图模型。只有用户要检查，或确实需要核对视角、文字、手部等问题时再使用识图能力。
