<p align="center">
  <img src="apps/control-center/assets/app-icon.png" width="96" alt="Suzu Lives logo" />
</p>

<h1 align="center">Suzu Lives</h1>

<p align="center">
  <strong>A life with agents.</strong><br />
  让 Companion Agent 成为能长期相处、记得彼此，也能实际行动的伙伴。
</p>

<p align="center">
  <a href="https://github.com/eryucheng/suzu-lives/releases/latest/download/Suzu-Lives-latest-win-x64.exe"><strong>下载 Windows x64 安装程序</strong></a> ·
  <a href="https://github.com/eryucheng/suzu-lives/releases">版本记录</a> ·
  <a href="LICENSE.md">Apache-2.0</a>
</p>

<p align="center">Companion Agent · Windows x64 · 本地优先</p>

![Suzu Lives Companion Agent 对话界面](docs/images/conversation-chat.png)

## 认识 Suzu Lives

Suzu Lives 是一款运行在 Windows 上、本地优先的 Companion Agent（陪伴型 Agent）桌面应用。它围绕每位 Companion Agent 组织长期关系、对话、记忆与日常互动：每位 Agent 都拥有独立的人设与相处设定、固定会话、长期记忆、资料、头像、声音、计划和能力开关。

每位 Companion Agent 的对话、关系资料、记忆、能力、计划、附件和用量都由 Suzu Lives 统一整理。你可以把一次次聊天积累成一段可维护、可延续的长期关系。

![Suzu Lives 玻璃对话界面](docs/images/conversation-glass.png)

## 功能地图

| 入口 | 可以做什么 |
| --- | --- |
| **问 Suzu** | 查询软件功能，定位设置入口，逐步配置 API 与能力，并直接完成软件支持的操作。 |
| **对话** | 管理多位 Companion Agent 及各自的固定会话；支持消息排队、处理中引导、停止、Markdown、表情、附件、语音输入与实时语音通话。 |
| **关系** | 管理相处设定与关系资料；浏览长期记忆、整理会话上下文、查看 Agent 日记。 |
| **今天** | 查看每位 Agent 的重要日期、纪念日、生日、节日、日程、今日成本与最近活动。 |
| **计划** | 创建一次性或循环计划，运行每位 Agent 的专属任务，并集中管理主动关心。 |
| **能力** | 为不同 Agent 启用图像生成、图像理解、视频理解、语音消息、网页自动化、邮箱通道、写日记和微信连接。 |
| **创造** | 在视觉工作台中组织提示词、视觉参考和候选结果，完成图片生成与编辑。 |
| **管理与设置** | 管理个人身份、主模型、API 连接、价格与调用流水、软件更新、数据位置、隐私设置和系统状态。 |

## 核心体验

### 每位 Agent 都有自己的连续生活

切换 Companion Agent 时，Suzu Lives 会继续使用对方对应的会话、相处设定、关系资料、能力配置和长期记忆。复杂任务进行中，你可以继续发送想法作为引导，也可以把后续消息排队或停止当前处理。

每位 Agent 可以读取和整理本机文件、处理任务，也可以调用你为其启用的图片、语音、网页等能力。需要确认的操作会在对话中发起审批，生成结果和附件也会回到同一段对话中。

### 记忆、上下文与日记各司其职

| 层次 | 作用 |
| --- | --- |
| **长期记忆** | 将事件、主题、人物状态、关系和原始证据组织为可检索的记忆网络，并在相关对话中自动想起合适内容。 |
| **记忆压缩器** | 自动或手动把较早上下文整理成摘要，同时保留最近原话；聊天界面继续显示完整对话。 |
| **Agent 日记** | 让指定 Agent 在设定时间回顾当天，并按日期保存独立的本地日记。 |

长期记忆可以在神经网络视图中搜索、定位、拖动和缩放，也可以查看来源与关联、测试一次实际召回会带给 Agent 哪些内容。

![Suzu Memory 可视化记忆神经网络](docs/images/memory-brain.png)

### 从聊天延伸到日常

- **主动关心**：Agent 根据对话内容和当前时间判断联系时机，并安排下一次检查。
- **日历与计划**：为每位 Agent 保存纪念日、生日和日程，创建一次性、每日或循环任务。
- **微信连接**：为每位 Agent 生成专属二维码，把微信消息、回复和选定附件路由到固定会话。
- **语音交流**：配置语音合成与语音识别后，可发送语音消息、主动拨打或接听实时语音电话。

<table>
  <tr>
    <td width="50%"><img src="docs/images/calendar-overview.png" alt="Suzu Lives Agent 日历" /></td>
    <td width="50%"><img src="docs/images/plan-management.png" alt="Suzu Lives 计划管理" /></td>
  </tr>
  <tr>
    <td align="center">重要日期与日程</td>
    <td align="center">一次性、循环与主动联系计划</td>
  </tr>
</table>

### 从感知到创作与行动

内置能力覆盖图片生成与编辑、图片理解、视频理解、语音消息、专用浏览器自动化和邮箱通道。网页自动化支持打开与读取页面、点击、填写、上传、下载和截图；邮箱通道可发送邮件，并把按主题路由的回信交给对应 Agent 的会话。

能力中心按 **感知、陪伴、行动、创作** 组织。你可以为不同 Agent 分别开关能力，也可以导入 Suzu Lives 支持的外部能力。

![按感知、陪伴、行动与创作组织的能力中心](docs/images/capabilities.png)

## 核心功能

### 主动关心与回访

开启“主动关心”后，在 Suzu Lives 运行期间，联系人可以根据此前的对话和当前时间安排后续联系：既可以持续地在合适时机问候，也可以只为“等结果”“晚点确认”这类具体事情创建一次性回访。

你也可以自己为联系人设置一次性或每天执行的计划，并随时查看、暂停或删除。自动联系仅在软件运行期间执行，所有计划都留在你看得见、能控制的范围内。

### 自定义壁纸

可以用自定义图片或视频作为壁纸。

![Suzu Lives 自定义壁纸对话界面](docs/images/wallpaper-chat.png)

![Suzu Lives 自定义壁纸设置](docs/images/wallpaper-settings.png)

### 记得你，也让你看得见

Suzu Memory 会把对话中值得保留的事件、主题、人物状态和关系组织成可追溯的网络；每条记忆都能关联到来源和相关内容。

你可以在记忆神经网络中拖动、缩放和搜索，也可以在记忆库查看原始证据与关联。对某个问题先运行一次“测试最终召回”，就能看到这一轮实际会带给 Agent 的记忆。错误内容可以审核、驳回或撤销，让长期记忆随关系一起维护。

![Suzu Memory：可浏览的记忆神经网络](docs/images/memory-brain.png)

![Suzu Lives 应用内语音通话](docs/images/voice-call.png)

### 一键新建人设

可以直接让 Suzu 助手创建新联系人、设定人设，或处理软件内的事情。

![Suzu 助手创建联系人与处理软件操作](docs/images/suzu-assistant-create-persona.png)

### 一键连接微信，手机上继续聊

在当前联系人的设置里点一次“连接微信”，就会生成专属二维码。用希望绑定的微信扫码，再按提示发出一条文字即可完成确认。

之后从微信发来的消息会进入这位联系人的固定对话，回复也会沿着同一段关系回来；多个联系人可以分别绑定，各自连接到固定对话。

![为当前联系人连接微信的二维码示意](docs/images/wechat-connect.png)

### 日历功能

设置联系人专属或共享的纪念日，注意事项，时间到了之后会通过时间感知hook注入给对应联系人

![为联系人添加日期](docs/images/calendar-add-date.png)

![日历中的联系人日期](docs/images/calendar-overview.png)

### 语音通话功能

在配置联系人对应的音色api后，agent不仅能发送语音条，也可以进行语音通话，通话将会保持原来的上下文。

![主动拨打语音电话](docs/images/voice-call-outgoing.png)

![Agent 发起的语音来电](docs/images/voice-call-incoming.png)

### 查看调用流水

统计软件内部所有功能的花销（需自行填写不同厂家价格）

![按功能筛选的调用流水和费用统计](docs/images/usage-invocation-log.png)

### 管理计划

Suzu lives内置计时器，调用计时器的行为可以统一在计划页面检查并且管理，也可以新建计划执行自己的脚本。

![统一查看和管理计划](docs/images/plan-management-glass.png)

### 相处设定

每位联系人隔离，可填写不同的设定。

![为不同联系人编辑相处设定](docs/images/relationship-setup.png)

## 快速开始

1. 在 Windows x64 设备上下载并安装 [最新版本](https://github.com/eryucheng/suzu-lives/releases/latest/download/Suzu-Lives-latest-win-x64.exe)。
2. 按首次引导选择主模型服务，填写模型与 API Key。
3. 创建第一位 Companion Agent，设置名字、人设与相处方式。
4. 开始对话；需要图片、语音、视频、网页或邮箱时，再到 **能力** 中配置对应服务与启用范围。

主模型负责日常对话和任务处理。图像、视频、语音和长期记忆等功能可以分别绑定自己的 API 连接与模型。

## 使用与数据说明

- 各 Agent 的会话、关系资料、记忆、计划、附件和设置保存在你选择的 Suzu 数据目录中。
- 模型、图像、语音、视频、邮箱、微信等功能会按你的配置连接对应服务；请求内容与费用由所选服务决定。
- 主动关心、计划、日记、微信和邮箱等持续功能由本机桌面端维护，并在 Suzu Lives 运行期间执行。
- 每项能力都可以为不同 Agent 单独开关；导入的外部能力可供 Agent 会话使用。
- 调用流水统一记录各项功能的用量；填写服务价格后可以估算成本。

## 许可证

Suzu Lives 采用 [Apache License 2.0](LICENSE.md) 发布。第三方组件与来源说明见 [NOTICE](NOTICE)。
