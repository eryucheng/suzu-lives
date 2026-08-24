import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilitySkillCatalog,
  capabilitySkillForName,
} from "../electron/services/agent-capability-skills.mjs";

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
