---
name: visual-reference-manager
description: 通过 Suzu Lives 维护用户明确要求保存、登记、查看、更新、删除或校验的视觉参考资料库。
---

# Visual Reference Manager

只在用户明确要求维护参考资料库时使用；不要把普通聊天附件自动永久保存。资料副本和清单都由 Suzu Lives 写入当前 Agent 的软件数据目录，Skill 不携带图片、源码、配置或凭据。

先根据用户说明和可用的视觉理解能力确认每张图片的实际内容、视角、`role`、`description`、`preserve`、`ignore` 与分组；不能只按文件名猜。角色只能是 `identity`、`location`、`object`、`style`，ID 使用稳定的小写英文层级，例如 `home.bedroom.door-view`。

使用稳定入口：

`suzu-lives visual-reference-manager init`

`suzu-lives visual-reference-manager list --query "卧室" --limit 10`

`suzu-lives visual-reference-manager show home.bedroom.door-view`

`suzu-lives visual-reference-manager validate`

新增、更新、换角色或删除时，先阅读 [维护计划格式](references/manifest-schema.md) 并创建版本为 1 的维护计划 JSON。`add` 需要 `source`、`id`、`role`、`description`、`preserve`、`ignore`、`sets`；`update` 只写要改的字段；`remove` 必须明确 `delete_file: true|false`。不要手工编辑 manifest。

始终先计划与 dry-run：

`suzu-lives visual-reference-manager apply --plan '<计划文件>' --dry-run`

只有 dry-run 成功、没有冲突，且用户已确认本批新增、更新或删除后，才执行同一计划的：

`suzu-lives visual-reference-manager apply --plan '<计划文件>'`

`apply` 会把整批图片与 manifest 作为一次原子事务处理；任一操作失败时整批不落盘。正式成功后运行 `validate`，并简短报告实际变更。只有用户明确要求删除时才使用 `remove`，并说明是否删除软件内副本。
