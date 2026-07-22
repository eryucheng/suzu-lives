---
name: image-generation
description: 使用统一图像引擎生成或编辑非“手机随手拍”类图片，或者在用户明确要求本地模型、ComfyUI、指定工作流时选择已注册的本地工作流。普通自拍、食物、房间和生活场景随手拍优先使用 phone-camera Skill。
---

# Image Generation

默认使用 API；不要主动把普通请求切到 ComfyUI。

## API 生成

```powershell
python scripts/abilities/image-generation/generate_image.py --prompt "画面中实际可见的内容" --send
```

只写画面内容和必要约束。不要主动选择模型、采样器、步数、CFG、LoRA 或 denoise。

## 明确使用 ComfyUI

只有用户明确说“本地”“ComfyUI”或指定本地工作流时，先查看已注册工作流：

```powershell
python scripts/abilities/image-generation/generate_image.py --list-workflows
```

选择语义匹配且 `enabled: true` 的工作流：

```powershell
python scripts/abilities/image-generation/generate_image.py --prompt "画面内容" --backend comfyui --workflow "workflow-id" --send
```

没有匹配工作流时如实说明尚未注册，不要假装执行，不要自动改用 API。用户要求新增或调整工作流时，读取 [comfyui-workflows.md](references/comfyui-workflows.md)，再维护 API Format 工作流和注册表。

## 参数边界

- 日常只选择 `--prompt`、`--backend`、`--workflow`、必要的 `--ref` 和 `--send`。
- 只有用户要求固定尺寸或复现结果时才使用 `--size`、`--seed`。
- 不在普通生成时修改配置文件。采样器、步骤、CFG、LoRA、denoise 和节点映射由工作流默认值负责。
- API 或 ComfyUI 失败时报告 `IMAGE_ERROR`，禁止静默切换后端。
