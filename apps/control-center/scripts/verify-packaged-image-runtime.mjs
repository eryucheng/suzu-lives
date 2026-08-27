import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ARGUMENT = "--worker";
const WEBP_FIXTURE = Buffer.from(
  "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoIAAkAAUAmJaACdLoABdQAAP7xTa/9lY/9Kx/6Vj9kj/cGZ9XX+AAA",
  "base64",
);

function clean(value) {
  return String(value ?? "").trim();
}

function errorDetail(error) {
  const details = [];
  let current = error;
  while (current && details.length < 4) {
    details.push(clean(current.stack || current.message || current));
    current = current.cause;
  }
  return details.filter(Boolean).join("\nCaused by: ");
}

async function writeReport(reportPath, value) {
  await writeFile(reportPath, `${JSON.stringify(value)}\n`, "utf8");
}

async function runWorker(resourcesPath, reportPath) {
  try {
    assert.equal(process.platform, "win32", "打包运行时验证只支持 Windows。 ");
    assert.ok(process.versions.electron, "验证进程必须由打包后的 Electron 可执行文件启动。 ");
    assert.equal(path.resolve(process.resourcesPath), resourcesPath, "Electron resourcesPath 与待验证安装包不一致。 ");
    const runtimeEntry = path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@suzu-lives",
      "suzu-agent-runtime",
      "src",
      "avatar-image.mjs",
    );
    const { normalizeSquareAvatarImage } = await import(pathToFileURL(runtimeEntry).href);
    const result = await normalizeSquareAvatarImage(WEBP_FIXTURE);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.width, 8);
    assert.equal(result.height, 8);
    assert.deepEqual(Buffer.from(result.bytes).subarray(0, 8), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    await writeReport(reportPath, { ok: true, resourcesPath });
  } catch (error) {
    await writeReport(reportPath, { ok: false, error: errorDetail(error) });
    process.exitCode = 1;
  }
}

function waitForChild(executable, args, options) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(executable, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-8_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => resolveChild({ code, signal, stdout, stderr }));
  });
}

async function runParent(appOutDir) {
  const outputDirectory = path.resolve(appOutDir);
  const resourcesPath = path.join(outputDirectory, "resources");
  const executable = path.join(outputDirectory, "Suzu Lives.exe");
  const temporaryRoot = path.resolve(
    clean(process.env.SUZU_LIVES_TEST_TEMP)
      || clean(process.env.RUNNER_TEMP)
      || tmpdir(),
  );
  const reportPath = path.join(temporaryRoot, `suzu-packaged-image-runtime-${process.pid}.json`);
  await rm(reportPath, { force: true });
  const outcome = await waitForChild(
    executable,
    [fileURLToPath(import.meta.url), WORKER_ARGUMENT, resourcesPath, reportPath],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let report = null;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    // The child diagnostics below retain its exit status and captured output.
  }
  if (outcome.code !== 0 || report?.ok !== true) {
    throw new Error([
      "打包后的 Electron 无法加载并执行 Sharp 图片运行时。",
      clean(report?.error),
      clean(outcome.stderr),
      clean(outcome.stdout),
      outcome.signal ? `signal=${outcome.signal}` : `exitCode=${outcome.code}`,
    ].filter(Boolean).join("\n"));
  }
  await rm(reportPath, { force: true });
  process.stdout.write(`Packaged Sharp image runtime verified: ${resourcesPath}\n`);
}

if (process.argv[2] === WORKER_ARGUMENT) {
  const resourcesPath = path.resolve(clean(process.argv[3]));
  const reportPath = path.resolve(clean(process.argv[4]));
  await runWorker(resourcesPath, reportPath);
} else {
  const appOutDir = clean(process.argv[2]) || path.resolve(HERE, "..", "dist", "win-unpacked");
  await runParent(appOutDir);
}
