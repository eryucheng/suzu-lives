---
name: software-navigation
description: 当用户想查看当前软件状态、找到或打开页面、切换主题时使用。先读取当前状态，再依据登记入口完成操作。
---

# 软件导航与操作

先调用 `suzu_software_status` 读取即时软件状态和已登记的页面入口。入口名称后的括号里是页面 ID；跳转时只使用这份状态返回的 ID。

需要打开页面时，调用 `suzu_software_action`：

- `action` 为 `navigate`
- `input` 为 `{ "destinationId": "状态返回的页面 ID" }`

需要切换外观时，调用 `suzu_software_action`：

- `action` 为 `set-theme`
- `input` 为 `{ "theme": "light" }` 或 `{ "theme": "dark" }`

工具返回 `completed` 后，再说明页面已经打开或主题已经切换。用户只想了解路径时，先给出简洁的界面路径，再按需要补充下一步。

状态还会给出软件数据目录和软件本体位置。它们用于核对本机事实；围绕当前请求读取需要的信息即可。
