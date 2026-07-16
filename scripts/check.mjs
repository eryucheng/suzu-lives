#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "node_modules"]);

function collect(directory) {
  const result = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isDirectory() && ignoredDirectories.has(item.name)) continue;
    const fullPath = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...collect(fullPath));
    else if (item.isFile() && item.name.endsWith(".mjs")) result.push(fullPath);
  }
  return result;
}

let failed = false;
for (const script of collect(root)) {
  const check = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  if (check.status === 0) {
    console.log(`OK ${path.relative(root, script)}`);
    continue;
  }
  failed = true;
  process.stderr.write(check.stderr || check.stdout || `无法检查 ${script}\n`);
}

if (failed) process.exitCode = 1;

