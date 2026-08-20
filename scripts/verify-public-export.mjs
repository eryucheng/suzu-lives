import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(REPOSITORY_ROOT, "config", "public-export-policy.json");
const POLICY_RELATIVE_PATH = "config/public-export-policy.json";

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result;
}

function readRef(argv) {
  const position = argv.indexOf("--ref");
  if (position === -1) return "HEAD";
  const ref = String(argv[position + 1] || "").trim();
  if (!ref || position + 2 !== argv.length) {
    throw new Error("用法：node scripts/verify-public-export.mjs --ref <候选提交>");
  }
  return ref;
}

function normalizeRepositoryPath(value) {
  const relative = String(value || "").trim().replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || relative.includes("../") || relative === "..") {
    throw new Error(`无效的私有路径：${value}`);
  }
  return relative;
}

async function readPolicy() {
  const parsed = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  if (parsed?.schema !== "suzu-lives-public-export-policy/v1" || !Array.isArray(parsed.privateOnlyPaths)) {
    throw new Error("公共导出策略格式无效。");
  }
  const privateOnlyPaths = [...new Set(parsed.privateOnlyPaths.map(normalizeRepositoryPath))];
  if (!privateOnlyPaths.length) throw new Error("公共导出策略至少需要一个私有路径。");
  return { privateOnlyPaths };
}

function trackedPathsFor(ref) {
  const result = runGit(["ls-tree", "-r", "--name-only", ref]);
  return new Set(result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean));
}

function referencesFor(ref, privatePath) {
  const referenceNeedles = [...new Set([
    privatePath,
    path.posix.basename(privatePath),
  ])];
  const result = runGit([
    "grep",
    "-n",
    "-I",
    "-F",
    ...referenceNeedles.flatMap((needle) => ["-e", needle]),
    ref,
    "--",
    ".",
    `:(exclude)${POLICY_RELATIVE_PATH}`,
  ], { allowFailure: true });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`无法检查 ${privatePath} 的公开引用：${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

async function main() {
  const ref = readRef(process.argv.slice(2));
  runGit(["rev-parse", "--verify", `${ref}^{tree}`]);
  const { privateOnlyPaths } = await readPolicy();
  const tracked = trackedPathsFor(ref);
  const violations = [];

  for (const privatePath of privateOnlyPaths) {
    if (tracked.has(privatePath)) violations.push(`包含私有文件：${privatePath}`);
    for (const reference of referencesFor(ref, privatePath)) {
      violations.push(`引用私有文件：${reference}`);
    }
  }

  if (violations.length) {
    process.stderr.write(`公共导出校验失败（${ref}）：\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`公共导出校验通过：${ref}\n`);
}

main().catch((error) => {
  process.stderr.write(`公共导出校验无法完成：${error?.message || error}\n`);
  process.exitCode = 1;
});
