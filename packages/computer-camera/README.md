# Computer camera

此包提供 `computer-camera` 的一次性真实摄像头能力：启动 detached OpenCV worker，warmup 后保存一帧，保持摄像头到 `active-seconds` 后自动释放，并以原子 JSON 状态文件报告 `captured`、`closed` 或 `error`。

运行数据仅位于 `<Suzu Lives dataRoot>/capabilities/computer-camera/`。它不依赖 capability registry、Electron 控制面、联系人项目或外部配置；也不会调用 image-vision。包内 `bin/computer-camera.mjs` 是该能力的薄入口，`worker/camera-worker.py` 使用 `--worker --output --status-file --camera-index --active-seconds --warmup-seconds` worker 参数契约。
