# Visual reference manager

软件拥有的 Agent 兼容入口，复用 `@suzu-lives/visual-reference-library` 的校验、路径限制、文件复制和原子 manifest 写入。稳定命令为 `suzu-lives visual-reference-manager init|list|show|validate|apply`。

默认资料库是当前 Agent 的 `<dataRoot>/agents/<agent>/visual-references/manifest.json`。`--manifest` 仅可选择同一 Agent 软件数据目录内的 `manifest.json`；计划和待导入图片是显式输入，正式资料副本与状态只写入 Suzu Lives 数据目录。

`apply --dry-run` 只校验完整计划，不创建文件；正式 `apply` 以单次文件/manifest 事务执行 `add`、`update` 和 `remove`，任何失败都会回滚已移动的文件。
