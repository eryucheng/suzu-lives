# 手机拍照式生图

这个模块让 Agent 通过统一图像引擎生成一张像真实手机随手拍出来的图片，而不是每次临时拼一串“8K、电影感、专业摄影”标签。默认后端是 API；只有用户明确要求时才使用已注册的本地 ComfyUI 工作流。

它把流程拆成三部分：

```text
phone-camera Skill
  ├─ 判断为什么拍、选择后摄 / 前摄自拍 / 镜面自拍、描述可见场景
  └─ 只为当前画面选择必要的视觉参考

take_photo.py
  └─ 加入固定拍摄几何和手机质感 → 调统一图像引擎 → 保存 → 可选发到聊天

image-generation
  ├─ API 后端（默认）
  └─ ComfyUI 工作流后端（明确指定时）

visual-reference-manager Skill + manage_references.py
  └─ 用户明确要求时，批量登记和维护人物、房间、物品、风格参考图
```

脚本只使用 Python 标准库，不需要安装 Pillow 或其他第三方包。有参考图时会提高人物、地点和物品的一致性，但生成模型仍不保证像素级复刻。

## 三种拍摄方式

- `rear`：后置摄像头。摄影者和手机都在镜头后，不应出现在画面里；适合食物、房间、街景和“眼前看到的东西”。
- `selfie`：前置摄像头自拍。画面视点就是手机镜头，所以手机本体不能出现在画面里；适合脸部、半身和直接自拍。
- `mirror`：镜面自拍。手机必须在镜中由人物拿着，镜子、人物和房间的透视要一致；适合穿搭和全身照。

这些约束位于 `profiles.json`。它是可编辑的普通配置，不需要让 Agent 每次重复生成相机规则。

## 配置

在仓库根目录运行：

```powershell
npm run setup
```

也可以手动复制两份配置：

```text
scripts/abilities/image-generation/config.example.json
  → scripts/abilities/image-generation/config.local.json

scripts/abilities/phone-camera/config.example.json
  → scripts/abilities/phone-camera/config.local.json
```

API、ComfyUI、保存和发送配置统一位于 `image-generation/config.local.json`。手机拍照配置只保留：

- `engine_config`：统一图像引擎配置路径；
- `size_by_shot`：三种拍摄方式默认尺寸；
- `references`：视觉参考库位置和单次上限；
- `output`：手机照片输出目录；
- `prompt`：可选的手机照片全局补充。

详细后端配置和工作流注册见 [统一图像生成引擎](../image-generation/README.md)。

`references.manifest` 指向参考库清单，默认是项目根目录下的 `visual-references/manifest.json`；`max_images` 是单次允许展开的参考图上限，默认 8，最大 16。中转服务除了 `/images/generations` 之外，还必须兼容 OpenAI Images 的 `/images/edits` multipart 请求，参考图功能才能使用。

`prompt.prefix` 和 `prompt.suffix` 是可选的全局补充。第一版保持为空即可；不要把 API Key 或聊天凭证写进提示词。

## 先检查最终提示词

下面的命令不会访问网络、不会消耗图片额度、不会发送消息：

```powershell
python ".\scripts\abilities\phone-camera\take_photo.py" --shot rear --scene "桌上刚端来的家常晚饭，旁边放着喝了一半的水" --dry-run
```

再分别检查自拍和镜面自拍：

```powershell
python ".\scripts\abilities\phone-camera\take_photo.py" --shot selfie --scene "刚睡醒坐在窗边，头发有点乱，穿普通居家服" --dry-run
python ".\scripts\abilities\phone-camera\take_photo.py" --shot mirror --scene "出门前在卧室穿衣镜前看今天的日常穿搭，全身入镜" --dry-run
```

## 建立视觉参考库

首次运行 `npm run setup` 会创建空的 `visual-references/manifest.json`。也可以单独初始化：

```powershell
python ".\scripts\abilities\phone-camera\manage_references.py" init
```

不要手工复制一堆图片后只靠文件名猜内容。每张图片都应登记：

- `role`：`identity`、`location`、`object` 或 `style`；
- `description`：图片实际是什么、从什么视角看到；
- `preserve`：生成时应该继承的稳定特征；
- `ignore`：临时衣服、杂物、姿势、原图光线等不应继承的内容；
- `sets`：同一人物或同一空间的一组可组合参考。

给 Agent 说“把这些卧室照片存成参考”即可触发 `visual-reference-manager` Skill。它会先识图、生成一份批量计划并 dry-run，确认没有冲突后才原子写入；任一操作失败时整批不落盘。详细计划格式在 [维护 Skill](../../../.claude/skills/visual-reference-manager/SKILL.md) 中按需读取，不会常驻主上下文。

搜索已有参考：

```powershell
python ".\scripts\abilities\phone-camera\manage_references.py" list --query "卧室" --limit 10
python ".\scripts\abilities\phone-camera\manage_references.py" show home.bedroom.door-view
python ".\scripts\abilities\phone-camera\manage_references.py" validate
```

真实图片和 `manifest.json` 默认被 Git 忽略；公开仓库只保留空的 `manifest.example.json`。

## 真实生成与发送

只生成并保存到 `output/phone-camera`：

```powershell
python ".\scripts\abilities\phone-camera\take_photo.py" --shot rear --scene "雨后小区路边的树和积水"
```

生成后通过 cc-connect 发到已配置会话：

```powershell
python ".\scripts\abilities\phone-camera\take_photo.py" --shot mirror --scene "出门前在玄关镜子里拍一张普通日常穿搭" --send
```

使用一个或多个参考 asset / set：

```powershell
python ".\scripts\abilities\phone-camera\take_photo.py" --shot mirror --scene "在卧室穿衣镜前拍今天的普通穿搭" --ref character-main --ref home-bedroom --send
```

没有 `--ref` 时脚本发送 JSON 到生成接口；只要指定一个 `--ref`，就会按 manifest 中的顺序读取图片和说明，并以 `image[]` multipart 字段发送到编辑接口。参考图会增加图像输入费用，所以只选当前画面真正需要的内容。

明确使用已注册的本地工作流：

```powershell
python ".\scripts\abilities\phone-camera\take_photo.py" --shot rear --scene "雨后的街道" --backend comfyui --workflow "workflow-id" --send
```

程序不会在 ComfyUI 失败时偷偷切回 API。可以临时用 `--size`、`--seed`、`--out` 覆盖少量通用值；采样器、步数、CFG、LoRA 和 denoise 保持在工作流配置内部。成功时脚本输出结构化结果，失败时返回非零退出码并输出 `PHOTO_ERROR`。

供 Agent 使用的拍照选择规则位于 [phone-camera Skill](../../../.claude/skills/phone-camera/SKILL.md)，通用生图与本地后端规则位于 [image-generation Skill](../../../.claude/skills/image-generation/SKILL.md)，低频的参考库维护规则位于 [visual-reference-manager Skill](../../../.claude/skills/visual-reference-manager/SKILL.md)。
