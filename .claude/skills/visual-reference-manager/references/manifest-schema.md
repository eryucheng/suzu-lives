# 视觉参考库维护格式

## Manifest

`visual-references/manifest.json` 由维护脚本生成和校验：

```json
{
  "version": 1,
  "assets": {
    "home.bedroom.door-view": {
      "path": "places/home/bedroom/door-view.jpg",
      "role": "location",
      "description": "从卧室门口看向床和窗户的视角",
      "preserve": ["床和窗户的位置", "衣柜样式", "墙面颜色"],
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

`role` 只能是：

- `identity`：人物身份、脸、身体外形；
- `location`：住宅、房间、街道等空间；
- `object`：手机、饰品、家具等具体物品；
- `style`：只定义画面风格，不定义人物和空间。

`description` 说明图片实际是什么；`preserve` 说明生成时应继承什么；`ignore` 说明不应从参考图继承什么。

## 批量维护计划

计划文件供 Agent 临时创建，顶层格式为：

```json
{
  "version": 1,
  "sets": {
    "home-bedroom": "同一间卧室的空间参考"
  },
  "operations": []
}
```

### 新增

```json
{
  "action": "add",
  "source": ".cc-connect/attachments/bedroom.jpg",
  "id": "home.bedroom.door-view",
  "role": "location",
  "description": "从卧室门口看向床和窗户的视角",
  "preserve": ["床的位置", "窗户的位置", "衣柜样式"],
  "ignore": ["临时杂物", "拍摄时间", "原图光线"],
  "sets": ["home-bedroom"]
}
```

脚本根据 `role` 和 `id` 自动生成目标路径并复制源文件。不要在计划中手写目标路径。

### 更新描述和分组

```json
{
  "action": "update",
  "id": "home.bedroom.door-view",
  "description": "更新后的准确描述",
  "preserve": ["床的位置", "窗户的位置"],
  "ignore": ["临时杂物"],
  "sets": ["home-bedroom"]
}
```

未写的字段保持原值；写出 `sets` 时会替换该 asset 的全部分组。当前 `update` 不替换图片文件，需要换图时先经用户确认删除旧 asset，再用新图重新登记。

如果修正 `role`，脚本会把图片一并迁移到对应分类目录，不会只留下错误路径；目标位置已经存在时会拒绝覆盖。

### 删除

```json
{
  "action": "remove",
  "id": "home.bedroom.door-view",
  "delete_file": true
}
```

`delete_file` 必须明确填写。`true` 同时删除库内图片，`false` 只从 manifest 移除。

## ID 规则

- 只用小写字母、数字、点和连字符；
- 人物：`character.main.face-front`、`character.main.body-full`；
- 空间：`home.bedroom.door-view`、`home.bathroom.mirror-view`；
- 物品：`phone.main.back`；
- set 使用短名称：`character-main`、`home-bedroom`。

一次计划不能多次操作同一 asset。新 ID 或目标文件已经存在时脚本会拒绝覆盖。
