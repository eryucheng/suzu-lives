#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["memory/manual_compactor/config.example.json", "memory/manual_compactor/config.local.json"],
  ["memory/rag/config.example.json", "memory/rag/config.local.json"],
  [
    "scripts/abilities/phone-camera/config.example.json",
    "scripts/abilities/phone-camera/config.local.json",
  ],
  [
    "scripts/abilities/image-generation/config.example.json",
    "scripts/abilities/image-generation/config.local.json",
  ],
  [
    "scripts/abilities/image-generation/workflows/registry.example.json",
    "scripts/abilities/image-generation/workflows/registry.local.json",
  ],
  ["visual-references/manifest.example.json", "visual-references/manifest.json"],
  [
    "scripts/abilities/connect_iphone/feedback_config.example.json",
    "scripts/abilities/connect_iphone/feedback_config.json",
  ],
];

let created = 0;
for (const [sourceName, targetName] of pairs) {
  const source = path.join(root, sourceName);
  const target = path.join(root, targetName);
  if (fs.existsSync(target)) {
    console.log(`保留现有配置：${targetName}`);
    continue;
  }
  fs.copyFileSync(source, target);
  console.log(`已创建：${targetName}`);
  created += 1;
}

console.log(created ? "请填写新建的本地配置后再运行对应模块。" : "本地配置已经存在，没有覆盖。" );
