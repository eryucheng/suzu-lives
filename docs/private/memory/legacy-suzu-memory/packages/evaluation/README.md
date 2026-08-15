# @suzu-memory/evaluation

`@suzu-memory/evaluation` 用于运行回归案例和公开数据集评测。

当前 ZH-4O 结果见 [评测说明](../../docs/benchmark-status.md)。

## 本地回归

在仓库根目录运行：

```powershell
npm test --workspace=@suzu-memory/evaluation
```

通用回归入口：

```powershell
node .\packages\evaluation\src\cli.mjs --help
```

它读取 `fixtures/` 下的固定案例。

### ZH-4O：端到端多选作答

先从官方 MOOM 仓库克隆原始对话与 `label_qa`，再生成本地数据：

~~~powershell
node ./packages/evaluation/src/zh4o-source-cli.mjs `
  --source-root "./runtime/benchmarks/zh4o/upstream/MOOM-Roleplay-Dialogue" `
  --output "./runtime/benchmarks/zh4o/moom-official-v1/data.json"
~~~

然后运行完整记忆流程和 A–E 作答：

```powershell
node .\packages\evaluation\src\zh4o-system-cli.mjs `
  --dataset ".\runtime\benchmarks\zh4o\moom-official-v1\data.json" `
  --config ".\suzu-memory.local.json" `
  --work-dir ".\runtime\benchmarks\zh4o\run" `
  --output ".\runtime\benchmarks\zh4o\run\report.json"
```

常用参数包括 `--candidate-k`、`--maximum-events`、`--maximum-content-characters`、`--maximum-context-characters`、`--maximum-semantic-passes`、`--without-embedding`、`--retain-sample-databases` 和 `--resume-sample-databases`。使用 `--dry-run` 可只检查数据结构。

数据集、临时数据库和报告建议放在仓库根目录的 `runtime/`。
