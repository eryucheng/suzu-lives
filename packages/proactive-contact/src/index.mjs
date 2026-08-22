export const PROACTIVE_CONTACT_ID = "proactive-contact";
export const PROACTIVE_CONTACT_NAME = "主动联系";

/**
 * Returns only the Agent-facing registration text. Suzu owns chain orchestration
 * and storage; the active direct conversation provides the scoped CLI invocation.
 */
export function renderProactiveContactSkill() {
  return `---
name: suzu-lives-proactive-contact
description: 说明 Suzu 的链式主动关心分工，并管理一次性临时回访；仅在链式自动任务触发、用户明确要求启动或恢复，或出现确实值得稍后回访的未完成事项时使用。
---

<!-- suzu-lives:ability:proactive-contact -->
# 主动联系

这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存、凭据或自动任务状态。当前 Suzu 直连会话的系统提示会提供已绑定当前会话范围的 schedule 命令；只使用那个软件命令，不依赖外部桥接器。

使用 Suzu 自动任务获得主动联系用户的机会。区分长期延续的“链式主动关心”和针对具体事情的“一次性临时回访”。软件关闭期间不执行或补跑任务。

当前 Suzu 直连会话的系统提示会给出这两类任务的实际提示词；它们由“主动联系”能力设置管理。创建任务时优先使用系统提示中的当前版本，不要把本文件里的示例当作固定文案。

## 链式主动关心

链式主动关心由软件维护为 A → B → 下一条 A：

1. A 是一次联系判断。收到 A 自动任务时，根据本轮时间、当前会话和最近对话判断是否适合联系用户；适合时只写自然、完整、可直接送达给对方的消息，暂不适合时只输出精确的 NO_REPLY。
2. A 完成后，软件会启动内部 B。B 负责为当前联系人创建下一次 A；B 的任务正文会提供准确的 schedule add 参数。
3. 普通聊天不续约链式任务。用户手动开启或恢复主动关心时，由软件补上链路。

以当前自动任务正文为准；A 的内容只负责联系判断和对方可见回复。

## 创建临时回访

只有当前对话出现一件确实会在稍后产生结果、状态变化或值得自然关心的事情时才创建。不要机械地给每段对话设置回访。

根据事情本身自由决定延迟时间，把必要情境直接写进提示词，不要使用“根据刚刚的对话”这种会失去指向的说法：

    <当前会话系统提示中的 schedule add 命令> --delay Xm --prompt "<系统提示中的临时回访提示词，并替换其中的 TIME、EVENT>" --desc "临时回访：EVENT_SHORT"

执行时替换 TIME、EVENT、EVENT_SHORT 和自然的 Xm（也可用 Xh）。临时回访触发后，当前会话已经出现结果时输出精确的 NO_REPLY；事情仍未有结果时自然询问；无论是否发送消息，都不要为这次回访继续创建自动任务。链式主动关心与临时回访互相独立，不要把回访描述写成“链式主动关心”。

## 提前结束回访

用户在自动任务到期前已经主动给出结果，而当前会话中能确定存在对应回访时，使用：

    <当前会话系统提示中的 schedule list 命令>
    <当前会话系统提示中的 schedule remove 命令>

只删除描述精确为 临时回访：EVENT_SHORT 的任务。无法确定对应哪一项时不要误删；保留自动任务，触发后由“已有结果则 NO_REPLY”规则兜底。
`;
}
