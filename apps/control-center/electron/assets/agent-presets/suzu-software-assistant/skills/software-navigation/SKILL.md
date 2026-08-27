---
name: software-navigation
description: 当用户要查看当前软件状态、查找或打开页面，或切换主题时使用。
---

# 软件状态与导航

查看当前主题、版本、更新状态、数据目录或程序位置时，调用 `suzu_software_status`。

查找页面时，调用 `suzu_software_page_search`。`query` 使用用户提到的页面名称、功能或目的；返回结果中的页面 ID 用于导航。

用户只询问入口时，说明查询结果中的界面路径。用户要求打开页面时，把选定的页面 ID 交给 `suzu_software_action` 的 `navigate` 动作。

用户明确指定浅色或深色时，直接调用 `suzu_software_action` 的 `set-theme` 动作。用户要求切换到另一种主题时，先读取当前状态，再设置相反的主题。根据工具的实际返回说明结果。
