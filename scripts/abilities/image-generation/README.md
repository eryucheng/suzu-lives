# 统一图像生成引擎

这个目录为云端 Images API 和本地 ComfyUI 提供同一个调用入口。默认后端始终由 `config.local.json` 的 `default_backend` 决定，示例配置固定为 `api`；程序不会因为 API 失败而偷偷切换到本地，也不会因为 ComfyUI 未启动而改用付费 API。

## 日常调用

```powershell
python .\scripts\abilities\image-generation\generate_image.py --prompt "雨后街边的普通手机照片" --send
```

只有明确需要本地工作流时才指定：

```powershell
python .\scripts\abilities\image-generation\generate_image.py --prompt "画面内容" --backend comfyui --workflow workflow-id --send
```

常用参数只有 `--prompt`、`--backend`、`--workflow`、`--ref` 和 `--send`。`--size`、`--seed` 保留给明确需要改变尺寸或复现结果的情况；采样器、步数、CFG、LoRA、denoise 和节点映射都放在工作流注册表中，不让 Agent 每次选择。

## 配置

运行 `npm run setup`，或手动复制：

```text
config.example.json → config.local.json
workflows/registry.example.json → workflows/registry.local.json
```

API 配置与原手机拍照模块相同。ComfyUI 默认地址为 `http://127.0.0.1:8188`，初始注册表没有启用任何工作流，因此框架存在但不会假装本地算法已经配置完成。

列出和验证本地工作流：

```powershell
python .\scripts\abilities\image-generation\generate_image.py --list-workflows
python .\scripts\abilities\image-generation\generate_image.py --validate-workflows
```

工作流必须从 ComfyUI 导出为 API Format。普通界面 JSON 含有顶层 `nodes` 数组，不能直接提交；验证命令会给出明确错误。注册方式见项目 Skill 的按需文档：`.claude/skills/image-generation/references/comfyui-workflows.md`。
