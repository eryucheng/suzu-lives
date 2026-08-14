# Visual reference manager

软件拥有的 Agent 兼容入口，复用 `@suzu-lives/visual-reference-library` 的校验、路径限制、文件复制和原子 manifest 写入。稳定命令为 `suzu-lives visual-reference-manager init|list|show|validate|apply --scope shared|contact`；每次操作都必须明确资料归属。

`shared` 是用户的共享资料库，位于 `<dataRoot>/visual-references/manifest.json`，适合家、常用物品、公共风格和用户明确指定可共享的本人资料。`contact` 是当前联系人的专属资料库，位于 `<dataRoot>/agents/<agent>/visual-references/manifest.json`，适合该联系人的脸、服装和私人物品。联系人专属资料不会暴露给其他联系人。

`--manifest` 仅可选择所选资料库内的 `manifest.json`；计划和待导入图片是显式输入，正式资料副本与状态只写入 Suzu Lives 数据目录。

`apply --dry-run` 只校验完整计划，不创建文件；正式 `apply` 以单次文件/manifest 事务执行 `add`、`update` 和 `remove`，任何失败都会回滚已移动的文件。
