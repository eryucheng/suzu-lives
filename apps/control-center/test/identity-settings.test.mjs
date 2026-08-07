import assert from "node:assert/strict";
import test from "node:test";

import { renderAdmin } from "../src/features/agent/index.mjs";

test("identity settings only edits the owner; contact identity stays in the conversation settings", () => {
  const view = renderAdmin({
    state: {
      adminTab: "agent",
      settings: {
        agentId: "agent-suzu",
        identity: {
          owner: { displayName: "诚也", avatarDataUrl: "" },
          defaultAgent: { displayName: "默认联系人", avatarDataUrl: "" },
          agents: { "agent-suzu": { displayName: "Suzu", avatarDataUrl: "" } },
        },
      },
    },
  });

  assert.match(view, /identity-grid--owner/u);
  assert.match(view, /data-admin-tab="agent">我<\/button>/u);
  assert.match(view, /data-identity-target="owner"/u);
  assert.equal((view.match(/data-identity-target=/gu) || []).length, 1);
  assert.doesNotMatch(view, /data-identity-target="agent:/u);
  assert.doesNotMatch(view, /data-identity-target="defaultAgent"/u);
  assert.doesNotMatch(view, /当前联系人/u);
  assert.doesNotMatch(view, /当前 Agent 工作目录/u);
  assert.doesNotMatch(view, /~\\\.claude\\projects/u);
  assert.doesNotMatch(view, /最大 2 MB/u);
});

test("the owner avatar uses the square crop dialog before saving", () => {
  const view = renderAdmin({
    state: {
      adminTab: "agent",
      settings: {},
      identityAvatarCrop: {
        target: "owner",
        source: "data:image/png;base64,avatar",
        imageWidth: 1600,
        imageHeight: 900,
        viewportWidth: 320,
        viewportHeight: 320,
      },
    },
  });

  assert.match(view, /data-identity-avatar-crop-stage/u);
  assert.match(view, /data-identity-avatar-crop-image/u);
  assert.match(view, /data-identity-avatar-crop-zoom/u);
  assert.match(view, /data-confirm-identity-avatar-crop/u);
  assert.match(view, /方框内的正方形区域会作为头像保存/u);
});

test("management directs contact creation back to the conversation instead of an identity page", () => {
  const view = renderAdmin({ state: { adminTab: "runtime", runtimeSection: "claude", agentRuntime: { claude: { status: "needs-project" } } } });

  assert.match(view, /data-open-contact-conversation/u);
  assert.match(view, /前往会话/u);
  assert.doesNotMatch(view, /data-open-admin="agent">选择联系人/u);
});
