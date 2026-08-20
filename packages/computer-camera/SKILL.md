---
name: computer-camera
description: 使用 Suzu Lives 软件拥有的真实电脑摄像头拍一张照片，并在后台自动释放设备。
---

# Computer Camera

这是真实电脑摄像头，不是 `phone-camera` 的图像生成，也不会自动调用 `image-vision`。

从此 Suzu Lives 软件包目录执行薄入口：

`node bin/computer-camera.mjs --camera-index 0`

可选 `--active-seconds <秒>`、`--warmup-seconds <秒>`；也可用 `SUZU_LIVES_DATA_ROOT` 或 `--data-root <软件数据目录>` 指定软件拥有的数据根。返回 `status: "captured"` 或 `"started"` 时才代表后台 worker 已启动；`outputPath` 与 `statusPath` 都在 Suzu Lives 数据目录，不会写入联系人工作目录。

摄像头会在 warmup 后写入照片，并继续保持到 `active-seconds` 到期再自动关闭；本机“警告：摄像头已开启”提示由用户确认关闭。若需要理解照片，等 `outputPath` 可用后再单独调用 image-vision，并把它作为明确给出的本地图片；不要把拍照和识图合成一次调用。若返回 `status: "error"` 或 `COMPUTER_CAMERA_ERROR`，如实说明 OpenCV、摄像头打开或读帧失败，不能声称已经拍到照片。
