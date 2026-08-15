# 私有 test 开发流程

> 此文档只放在私有仓库 `eryucheng/suzu-lives-private` 的 `test` 分支，用于跨电脑开发时确认顺序。它不属于私有 `main` 或公开仓库 `eryucheng/suzu-lives`，发布时不要带入。

```text
本地开发 → 私有 test → 私有 main → 公开 main → vX.Y.Z 标签 / GitHub Release
```

## 1. 本地开发

完成一项改动后，只提交该项相关文件。不要把工作区内其他尚在开发的功能、缓存或临时文件一起提交。

## 2. 推送私有 test 并实际测试

将候选提交推送到私有仓库的 `test` 分支：

```text
git push origin test
```

`test` 的 GitHub Actions 会自动运行完整测试，并构建 NSIS 测试安装器。测试电脑使用 `Suzu Dev Update` 下载最新成功构建并覆盖安装，进行真实使用验证；它不影响正式软件内更新。

首次从旧 ZIP 解压版切换到 NSIS 安装器时，在安装向导中选择原有软件目录；后续安装会沿用该位置。

## 3. 进入私有 main

测试通过后，只把已经验证的功能提交带入私有 `main`。必要时使用挑选提交的方式推进，而不是无差别合并整个 `test` 分支。

私有 `main` 是完整能力的稳定基线，但不承载本机或 test 专用开发规则。

推进私有 `main` 时，以下私有 `test` 专用路径不得挑选、合并或复制：

- `docs/private-test-development-workflow.md`
- `docs/private/**`（其中 `docs/private/memory/**` 仅供开发查阅）
- `tools/suzu-dev-update/Suzu Dev Update.cmd`
- `tools/suzu-dev-update/suzu-dev-update.ps1`

## 4. 整理并同步公开版本

从私有稳定版本整理开源版本后，再同步到公开仓库 `eryucheng/suzu-lives` 的 `main`。不得直接整体公开私有仓库；必须移除不公开的能力、内部配置、私有凭据和 test 专用文件。

## 5. 正式发布

公开 `main` 验收后，打与应用版本一致的 `vX.Y.Z` 标签。标签触发正式 NSIS 安装器、GitHub Release 和软件内的正式更新；普通推送公开 `main` 不等于发布。

- 私有 `test` 可以频繁迭代；正式用户只接收公开 Release。
- 未经明确确认，不擅自合并分支、推送公开仓库、打标签、创建 Release 或修改版本号。
