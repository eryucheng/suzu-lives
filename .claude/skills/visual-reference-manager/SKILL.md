---
name: visual-reference-manager
description: 维护项目的视觉参考资料库。用户明确要求把收到的图片保存、登记或批量整理为人物脸、身体、服装、住宅房间、物品或风格参考，或者要求查看、修改、替换、删除、校验已有参考资料时使用。普通看图、拍照和临时生成图片不使用。
---

# Visual Reference Manager

只在用户明确要求维护参考库时操作；不要把普通聊天附件自动永久保存。

## 工作流

1. 找到用户指定的本地图片附件。
2. 优先使用项目现有的 `image-vision` Skill 或当前模型可用的视觉能力查看每张图片，并结合用户说明判断它是什么。两者都不可用时，集中向用户确认图片内容、视角和需要保留的特征；不能只根据文件名猜。
3. 阅读 [manifest-schema.md](references/manifest-schema.md)，为本批图片制作一份维护计划。
4. 同一批有不确定分类、同一空间关系或保留项时，集中向用户确认一次；明确的项目直接继续。
5. 先运行：

   ```powershell
   python scripts/abilities/phone-camera/manage_references.py apply --plan "计划文件路径" --dry-run
   ```

6. dry-run 成功且不存在需要用户决定的覆盖、删除或冲突时，再去掉 `--dry-run` 正式执行。
7. 运行 `validate`，最后用简短列表告诉用户新增、更新或删除了哪些 asset 和 set。

## 约束

- 不直接手工编辑 `visual-references/manifest.json`，始终使用维护脚本。
- ID 使用稳定、可读的小写英文层级，例如 `home.bedroom.door-view`。
- 每张图必须分别写清 `role`、`description`、`preserve` 和 `ignore`；文件名不算描述。
- 同一张图片只承担明确角色。人物图不继承背景和姿势，空间图不定义人物身份。
- 新图片与已有 ID 冲突时不覆盖，先向用户说明并确认后续是更新描述、删除旧项还是另建 ID。
- 只有用户明确要求删除时才生成 `remove` 操作，并明确选择是否删除磁盘图片。
- 私人脸部和住宅图片只放在 `visual-references/`，不移入 Skill，也不提交到公开仓库。
