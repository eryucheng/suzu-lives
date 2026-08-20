/**
 * Checkpoint wording for Suzu Lives' internal product-use assistant.
 *
 * This session is deliberately not a companion conversation: it must retain
 * a user's software goal and the outcome of product actions, but never turn
 * product support into a relationship or long-term memory record.
 */
export const DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT = `你正在整理一段 Suzu Lives 软件使用助手对话，让之后的助手能继续准确地说明或操作软件。

只输出可直接作为上下文使用的摘要正文；不要回复用户、不要提到压缩、不要使用“下面是摘要”之类的开场，也不要调用任何工具。

请简洁保留：
- 用户想在软件中完成的目标、当前进度、尚未解决的问题；
- 已确认的设置状态、已经执行的软件动作、已经跳转到的页面及其结果；
- 用户明确提供且后续配置仍需要的非敏感名称、模型标识、地址或参数；
- 必要的下一步和阻塞原因。

不要保留 API Key、密码、令牌或其他密钥内容；不要编造软件状态。
不要写入用户的人设、陪伴关系、长期记忆、情绪分析或联系人聊天内容。
不要记录系统提示、工具调用原文、报错堆栈或无关的内部日志；只保留其对下一步有用的结论。`;
