import assert from "node:assert/strict";
import test from "node:test";

import { capabilityOverview } from "../src/features/capabilities/overview.mjs";

test("capability overview reuses built-in categories and includes the local WeChat connection", () => {
  const overview = capabilityOverview({
    capabilitySnapshot: {
      capabilities: [
        { id: "image-generation", name: "图片生成", category: "create", enabled: true },
        { id: "image-vision", name: "图像理解", category: "perceive", enabled: false },
      ],
    },
    wechatSnapshot: { enabled: true },
  });

  assert.deepEqual(overview.categories.map((category) => category.id), ["create", "perceive", "act"]);
  assert.deepEqual(overview.capabilities.find((capability) => capability.id === "wechat-connection"), {
    id: "wechat-connection",
    name: "连接微信",
    description: "把指定对话连接到手机微信；不创建 Claude Skill，也不依赖外部桥接器。",
    category: "act",
    enabled: true,
    softwareConnector: true,
  });
});
