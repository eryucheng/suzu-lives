# 电脑摄像头

这个模块让 Agent 调用电脑上的真实摄像头取得一张当前画面。它只负责拍照，不负责识图，也不会把画面自动发到聊天。

当前实现只在 Windows 验证。摄像头打开后：

- 预热约 0.8 秒并保存一张 JPEG；
- 后台继续保持摄像头约 10 秒，然后自动释放；
- 桌面显示持续警告“警告：摄像头已开启”，直到用户点击“确定”；
- 拍照结果返回后，Agent 可以继续处理，不会被十秒摄像头进程或提示窗口占住。

## 安装

需要 Python 3.10 或更高版本，以及 OpenCV：

```powershell
python -m pip install opencv-python
```

把 [computer-camera Skill](../../../.claude/skills/computer-camera/SKILL.md) 保留在项目中，并在 Claude Code 权限中允许调用该脚本。整套权限示例已经包含它：

```text
integrations/claude-code/settings.example.json
```

## 使用

在项目根目录运行：

```powershell
python scripts/abilities/computer-camera/capture_camera.py
```

多摄像头设备可以指定编号：

```powershell
python scripts/abilities/computer-camera/capture_camera.py --camera-index 1
```

成功结果包含：

- `status: captured`
- `ready: true`
- `outputPath`：本次照片的完整路径

照片保存在 `output/computer-camera/`，运行状态保存在其 `runtime/` 子目录；整个 `output/` 默认不由 Git 跟踪。

## 与识图能力配合

需要了解画面内容时，把 `outputPath` 再交给 `image-vision` Skill。摄像头脚本和识图脚本保持分离，使 Agent 可以自由决定只保存照片、稍后识别，或者换一个具体问题重新识别同一张照片。

脚本失败时不要连续重复打开摄像头。先检查摄像头是否被其他程序占用、Windows 隐私权限是否允许桌面应用访问，以及 `--camera-index` 是否正确。
