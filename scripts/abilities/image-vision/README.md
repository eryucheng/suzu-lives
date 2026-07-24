# 外部模型识图

这个模块供不具备原生视觉能力的主模型读取一张本地图片。它调用支持图片输入的 OpenAI
Chat Completions 兼容接口，把返回内容作为外部视觉观察交给 Agent。

## 配置

先运行：

```powershell
npm run setup
```

然后填写：

```text
scripts/abilities/image-vision/config.local.json
```

最少需要配置：

```json
{
  "openai": {
    "api_key": "YOUR_API_KEY",
    "base_url": "https://example.com/v1",
    "model": "your-vision-model"
  }
}
```

也可以使用环境变量：

- `VISION_API_KEY`
- `VISION_BASE_URL`
- `VISION_MODEL`

脚本还兼容 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`，但专用的 `VISION_*` 优先级更高。

## 使用

读取整张图片：

```powershell
python scripts/abilities/image-vision/vision.py "C:\images\photo.jpg"
```

回答具体问题：

```powershell
python scripts/abilities/image-vision/vision.py `
  "C:\images\food.jpg" `
  --question "图片里有什么食物？只说明能直接看清的内容"
```

支持 JPG、PNG、WebP 和 GIF。图片过大或格式需要转换时，可以安装 Pillow：

```powershell
python -m pip install Pillow
```

没有 Pillow 时，大小未超过配置上限的常见静态图片仍可直接发送。

## 行为边界

- 图片会被编码后发送到你配置的外部视觉服务；敏感图片是否适合上传由使用者决定。
- 脚本不会识别或确认真实人物身份，也不会推测敏感属性。
- 人物图片被上游模型误拒时，只会使用中性描述提示重试一次，不会无限规避审核。
- 外部模型仍拒绝或请求失败时，脚本会明确返回 `VISION_REFUSED` 或 `VISION_ERROR`，Agent
  不应自行补全图中内容。
- `--detail` 仅作为旧调用兼容参数；新调用使用 `--question`。
