---
name: contact-avatar
description: 当用户要为联系人查找、裁剪、设置或更换头像时使用。
---

# 联系人头像

先确定目标联系人和头像来源。创建联系人后优先使用创建结果中的 `contactId`，已有联系人可以先用 `suzu_contact_search` 取得 ID。

## 公开角色

直接使用 `suzu_software_action` 的 `lookup-contact-avatar`，传入 `{ query, contactId }`。软件会自动完成中文角色解析、肖像匹配、图片下载、主体视觉定位、正方形构图和联系人头像保存；通常只需要这一次动作。角色解析优先使用 Bangumi 的角色与作品信息，头像优先选择 AniList 的角色肖像，并保留兼容来源。

返回 `needs-confirmation` 时，候选会包含 `candidateId`、角色名称、别名和关联作品。把足以区分角色的候选交给用户选择，再以 `{ query, candidateId, contactId }` 重试。返回 `completed` 且 `applied` 为 `true` 时，头像已经保存到联系人。

只查找预览时省略联系人，结果会返回角色条目、本机 `avatarPath`，以及同一次 Bangumi 角色识别得到的 `profile`。已有 `avatarPath` 时，使用 `set-contact-avatar` 直接应用，无需再次联网查找。

## 本机图片

用户提供图片时取得绝对路径，调用 `set-contact-avatar`，传入 `{ contactId, avatarPath }`。软件读取不超过 2 MB 的 PNG、JPEG 或 WebP，由一次性图片判断定位头部，裁剪与编码由本机图片代码完成；裁剪保持原比例，输出为正方形头像并统一保存为 PNG，源文件保持原样。视觉判断暂时不可用时会使用适合人物立绘的上部构图继续完成。

同名联系人返回 `needs-confirmation` 时，用候选中的联系人 ID 重试。根据工具返回说明实际来源和保存结果。
