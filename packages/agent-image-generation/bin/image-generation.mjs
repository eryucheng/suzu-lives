#!/usr/bin/env node
import { AgentImageGenerationError, runAgentImageGenerationCli } from "../src/index.mjs";

function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

try {
  emit(await runAgentImageGenerationCli(process.argv.slice(2)));
} catch (error) {
  emit({ status: "error", code: "IMAGE_ERROR", error: error instanceof AgentImageGenerationError ? error.message : "图像生成失败。" });
  process.exitCode = 1;
}
