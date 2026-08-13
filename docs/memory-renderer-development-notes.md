# 记忆渲染开发备忘

这份文档记录记忆系统里容易混淆、需要在后续开发中反复核对的历史来源。

## 远端 `suzu-memory` 推送前的旧版大脑渲染器

- 源仓库：`D:\Apps\AI\Suzu Lives`
- 当时实际开发分支：`feature/suzu-lives-direct-chat`
- 推送前最后提交：`2ec1f5ce516e1360826b1a297ad244bae705f226`（2026-08-07）
- 画布渲染器：`D:\Apps\AI\Suzu Lives\apps\control-center\src\features\memory-brain\brain-view.mjs`
- 图结构布局器：`D:\Apps\AI\Suzu Lives\packages\memory-visualization\src\brain-layout.mjs`

需要精确查看该版本时，不要依赖工作区当前文件，使用：

```powershell
git -C 'D:\Apps\AI\Suzu Lives' show '2ec1f5ce516e1360826b1a297ad244bae705f226:apps/control-center/src/features/memory-brain/brain-view.mjs'
git -C 'D:\Apps\AI\Suzu Lives' show '2ec1f5ce516e1360826b1a297ad244bae705f226:packages/memory-visualization/src/brain-layout.mjs'
```

说明：远端 `suzu-memory` 的首个公开快照是 `10392e5`（2026-08-10），没有更早的远端父提交；需要比较“推送前”的效果时，以上旧仓库提交才是基准。

## 旧版记忆数据库

主要历史数据库（此前用于旧版大脑渲染效果）：

`D:\Apps\AI\Suzu Lives\runtime\memory-evaluation\baseline-data\agents\agent-1cb074e5765b1ae6\memory\memory.db`

其他位于 `D:\Apps\AI\Suzu Lives\runtime\memory-evaluation\` 的 `schema-v*-validation-*\memory.db` 是 schema 验证产物，不应默认当作真实历史记忆的导入来源。

### 已核对的旧库统计

该库为 schema v3，只有 `utterance` 与 `event` 两类节点：

- 总节点：4,666
  - 原文证据 `utterance`：4,528
  - 事件 `event`：138
- 总连线：5,605
  - `followed_by`：4,527
  - `supported_by`：1,044
  - `associated_with`：28
  - `timeline_next`：6

旧版大脑画布默认排除 `utterance`。因此其实际可见数据是 138 个 `event` 节点、34 条 `event` 到 `event` 的连线；不要把 4,666 / 5,605 当成旧版画面中同时可见的数量。
