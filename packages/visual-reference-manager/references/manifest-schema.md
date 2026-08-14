# 视觉参考维护计划格式

`suzu-lives visual-reference-manager` 管理的软件资料库使用 version 1 manifest：

```json
{
  "version": 1,
  "assets": {
    "home.bedroom.door-view": {
      "path": "places/home/bedroom/door-view.jpg",
      "role": "location",
      "description": "从卧室门口看向床和窗户的视角",
      "preserve": ["床和窗户的位置", "衣柜样式"],
      "ignore": ["临时杂物", "原图光线"]
    }
  },
  "sets": {
    "home-bedroom": {
      "description": "同一间卧室的空间参考",
      "assets": ["home.bedroom.door-view"]
    }
  }
}
```

`role` 只能是 `identity`、`location`、`object` 或 `style`。`description` 描述图片实际内容；`preserve` 是生成应继承的稳定特征；`ignore` 是不应继承的暂时因素。

维护计划是一个独立的 version 1 JSON：

```json
{
  "version": 1,
  "sets": {
    "home-bedroom": "同一间卧室的空间参考"
  },
  "operations": []
}
```

新增资料：

```json
{
  "action": "add",
  "source": "用户明确给出的本地图片",
  "id": "home.bedroom.door-view",
  "role": "location",
  "description": "从卧室门口看向床和窗户的视角",
  "preserve": ["床的位置", "窗户的位置"],
  "ignore": ["临时杂物", "拍摄时间"],
  "sets": ["home-bedroom"]
}
```

脚本根据 `role` 和 `id` 生成软件资料库内的目标路径；计划中不能手写目标路径，也不会覆盖已有 ID 或文件。

更新资料可以只带需要改变的 `description`、`role`、`preserve`、`ignore` 或 `sets`。写出 `sets` 会替换该资料的全部分组；修改 `role` 会在同一原子事务中移动软件内副本。替换图片须先经用户确认删除旧资料，再以新 ID 或重新登记的 `add` 完成。

删除资料必须明确：

```json
{
  "action": "remove",
  "id": "home.bedroom.door-view",
  "delete_file": true
}
```

`delete_file: true` 同时移除软件内图片，`false` 只从 manifest 移除。一次计划不能多次操作同一资料。先运行 `apply --dry-run`，确认后才执行正式 `apply`。
