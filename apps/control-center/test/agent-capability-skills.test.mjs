import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilitySkillCatalog,
  capabilitySkillForName,
} from "../electron/services/agent-capability-skills.mjs";
import { createCapabilityRegistry } from "../electron/services/capability-registry.mjs";

const actions = [
  {
    capabilityId: "image-generation",
    capabilityName: "图像生成",
    capabilityDescription: "生成、编辑图片，并可结合视觉参考。",
    action: "generate",
    actionName: "生成图片",
    actionDescription: "input 必须包含图片提示词，成功后会投放到当前聊天。",
  },
  {
    capabilityId: "web-browser",
    capabilityName: "网页自动化",
    capabilityDescription: "访问、阅读和操作已登录网页。",
    action: "open",
    actionName: "打开网页",
    actionDescription: "input.url 指向要打开的网页。",
  },
  {
    capabilityId: "web-browser",
    capabilityName: "网页自动化",
    capabilityDescription: "访问、阅读和操作已登录网页。",
    action: "snapshot",
    actionName: "读取网页",
    actionDescription: "读取当前网页的文字和可交互元素。",
  },
  { capabilityId: "not valid", action: "ignored", actionDescription: "不应被暴露。" },
];

test("capability Skill catalog has one concise entry per enabled product capability", () => {
  assert.deepEqual(capabilitySkillCatalog(actions), [
    { name: "suzu-image-generation", description: "图像生成：生成、编辑图片，并可结合视觉参考。" },
    { name: "suzu-web-browser", description: "网页自动化：访问、阅读和操作已登录网页。" },
  ]);
});

test("capability Skill loads the matching action contract and no other capability", () => {
  const skill = capabilitySkillForName(actions, "suzu-web-browser");
  assert.equal(skill.name, "suzu-web-browser");
  assert.match(skill.content, /capabilityId：`web-browser`/u);
  assert.match(skill.content, /action：`open`/u);
  assert.match(skill.content, /action：`snapshot`/u);
  assert.doesNotMatch(skill.content, /image-generation/u);
  assert.equal(capabilitySkillForName(actions, "suzu-not-enabled"), null);
});

test("sticker Skill is discoverable without placing contact routing language in its prompt", () => {
  const stickerActions = createCapabilityRegistry().agentActions({ capabilityId: "emoji-sticker" });
  assert.deepEqual(capabilitySkillCatalog(stickerActions), [{
    name: "suzu-emoji-sticker",
    description: "聊天表情：用内置或收藏表情自然回应聊天；适合用图片表达情绪、态度或玩笑时，读取本 Skill 取得候选并发送。",
  }]);
  const skill = capabilitySkillForName(stickerActions, "suzu-emoji-sticker");
  assert.match(skill.content, /action：`recommend`/u);
  assert.match(skill.content, /action：`search`/u);
  assert.match(skill.content, /action：`send`/u);
  assert.match(skill.content, /categoryName/u);
  assert.match(skill.content, /若还有独立的对话内容就自然接着说/u);
  assert.match(skill.content, /本轮表达完整时直接完成/u);
  assert.doesNotMatch(skill.description, /当前联系人/u);
  assert.doesNotMatch(skill.content, /当前联系人/u);
});

test("the generic mail Skill explains how a business mail Skill sends an email", () => {
  const mailActions = [{
    capabilityId: "mail-bridge",
    capabilityName: "邮箱通道",
    capabilityDescription: "通过已配置的邮箱发送和接收邮件。",
    action: "send",
    actionName: "发送邮件",
    actionDescription: "input 必须包含邮件正文。",
  }];
  assert.deepEqual(capabilitySkillCatalog(mailActions), [{
    name: "suzu-mail-bridge",
    description: "邮箱通道：通过已配置的邮箱发送和接收邮件。",
  }]);

  const skill = capabilitySkillForName(mailActions, "suzu-mail-bridge");
  assert.match(skill.content, /邮件业务 Skill/u);
  assert.match(skill.content, /先从技能目录读取/u);
  assert.match(skill.content, /subject: "业务 Skill 指定的主题"/u);
  assert.doesNotMatch(skill.content, /自动化待办/u);
});

test("follow-up Skill is available when the current contact can maintain scheduled tasks", () => {
  const scheduleActions = [
    {
      capabilityId: "schedule",
      capabilityName: "计划",
      capabilityDescription: "创建和维护当前联系人的对话定时任务。",
      action: "add",
      actionName: "创建计划",
      actionDescription: "创建当前联系人的对话定时任务。",
    },
    {
      capabilityId: "schedule",
      capabilityName: "计划",
      capabilityDescription: "创建和维护当前联系人的对话定时任务。",
      action: "list",
      actionName: "查看定时任务",
      actionDescription: "读取当前联系人的待执行定时任务。",
    },
    {
      capabilityId: "schedule",
      capabilityName: "计划",
      capabilityDescription: "创建和维护当前联系人的对话定时任务。",
      action: "remove",
      actionName: "取消定时任务",
      actionDescription: "取消当前联系人的指定定时任务。",
    },
  ];

  assert.deepEqual(capabilitySkillCatalog(scheduleActions), [
    {
      name: "suzu-follow-up",
      description: "在当前对话出现明确的会在短期内继续发展的事情时，为当前联系人创建并维护回访。",
    },
    { name: "suzu-schedule", description: "计划：创建和维护当前联系人的对话定时任务。" },
  ]);

  const followUp = capabilitySkillForName(scheduleActions, "suzu-follow-up");
  assert.match(followUp.content, /# 回访/u);
  assert.match(followUp.content, /suzu-schedule/u);
  assert.match(followUp.content, /delay/u);

  const schedule = capabilitySkillForName(scheduleActions, "suzu-schedule");
  assert.match(schedule.content, /## 查看任务/u);
  assert.match(schedule.content, /action: "list"/u);
  assert.match(schedule.content, /action: "remove"/u);
  assert.match(schedule.content, /创建新的任务并确认创建结果后，取消原任务/u);
});
