# ComfyUI 工作流注册

只在用户要求新增、替换或调整本地工作流时读取本文件。

## 准备工作流

1. 在 ComfyUI 界面中把工作流调通。
2. 导出 **API Format** JSON。普通界面工作流顶层含 `nodes` 数组，不能提交给 `/prompt`。
3. 把 API JSON 放到 `scripts/abilities/image-generation/workflows/`。
4. 在 `registry.local.json` 中登记逻辑输入与真实节点输入的映射。
5. 运行 `--validate-workflows`；验证失败时不要启用。

## 注册格式

```json
{
  "version": 1,
  "workflows": {
    "realistic-local": {
      "enabled": true,
      "description": "本地写实文生图，不接收参考图",
      "file": "realistic-local.api.json",
      "bindings": {
        "prompt": { "node": "6", "input": "text" },
        "negative_prompt": { "node": "7", "input": "text" },
        "seed": { "node": "3", "input": "seed" },
        "steps": { "node": "3", "input": "steps" },
        "cfg": { "node": "3", "input": "cfg" },
        "width": { "node": "5", "input": "width" },
        "height": { "node": "5", "input": "height" }
      },
      "defaults": {
        "negative_prompt": "low quality, blurry, watermark, text",
        "steps": 20,
        "cfg": 4.5
      },
      "reference_slots": [],
      "output_nodes": ["9"]
    }
  }
}
```

`prompt` binding 必填。`defaults` 的键必须已经出现在 `bindings` 中。宽高、种子等只有工作流提供对应 binding 时才会被命令行覆盖。

## 参考图槽

有 `LoadImage` 或同类图片输入节点时登记：

```json
"reference_slots": [
  {
    "node": "12",
    "input": "image",
    "roles": ["identity"],
    "required": true
  },
  {
    "node": "13",
    "input": "image",
    "roles": ["location", "object"],
    "required": false
  }
]
```

角色只用于把当前参考图分配给正确输入槽，不会改变工作流算法。槽位不足或必需参考缺失时程序会拒绝执行，避免静默丢图。

## 修改不常用参数

不为 steps、CFG、采样器、scheduler、denoise、checkpoint 或 LoRA 增加日常命令行参数。需要长期改变时：

- 在 API JSON 中修改固定值；或者
- 为该输入增加 binding，并在 `defaults` 中设置新值。

只有用户明确要求临时实验时才复制一份工作流或注册项，避免改变其他场景的稳定默认结果。

## 验证

```powershell
python scripts/abilities/image-generation/generate_image.py --validate-workflows
```

验证只检查本地 JSON、节点、输入和输出映射，不会启动生图、不会调用 API。
