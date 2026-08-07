#!/usr/bin/env node

import path from "node:path";

import {
  createCurrentRetrieverExecutor,
  loadEvaluationCases,
  runMemoryEvaluation,
  writeEvaluationReport,
} from "./index.mjs";

function parseArguments(argv) {
  const values = {
    databasePath: "",
    agentId: "",
    casesPath: "",
    outputPath: "",
    includeContext: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--database") values.databasePath = argv[++index] || "";
    else if (argument === "--agent") values.agentId = argv[++index] || "";
    else if (argument === "--cases") values.casesPath = argv[++index] || "";
    else if (argument === "--output") values.outputPath = argv[++index] || "";
    else if (argument === "--include-context") values.includeContext = true;
    else if (argument === "--strict") values.strict = true;
    else if (["--help", "-h"].includes(argument)) values.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return values;
}

function usage() {
  return `用法：
  node packages/memory-evaluation/src/cli.mjs \\
    --database <memory.db> \\
    --agent <agent-id> \\
    --cases <cases.json> \\
    [--output <report.json>] [--include-context] [--strict]

默认不调用Embedding API，只评测当前离线文本与时间召回路径。
--include-context 会把实际注入文本写入本机报告，报告不得上传仓库。
--strict 会在存在未通过案例时返回非零退出码。`;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  for (const [name, value] of [
    ["--database", args.databasePath],
    ["--agent", args.agentId],
    ["--cases", args.casesPath],
  ]) {
    if (!value) throw new Error(`缺少参数 ${name}。\n\n${usage()}`);
  }
  const loaded = loadEvaluationCases(args.casesPath);
  const execute = createCurrentRetrieverExecutor({
    databasePath: args.databasePath,
    agentId: args.agentId,
  });
  const report = await runMemoryEvaluation({
    cases: loaded.cases,
    execute,
    includeContext: args.includeContext,
  });
  if (args.outputPath) {
    report.caseSource = loaded.sourcePath;
    report.reportPath = writeEvaluationReport(args.outputPath, report);
  }
  process.stdout.write(`${JSON.stringify({
    status: report.summary.failed ? "baseline-has-failures" : "passed",
    summary: report.summary,
    reportPath: args.outputPath ? path.resolve(args.outputPath) : "",
  }, null, 2)}\n`);
  if (args.strict && report.summary.failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});
