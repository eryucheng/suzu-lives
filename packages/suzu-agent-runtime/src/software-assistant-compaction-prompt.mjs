/**
 * Checkpoint wording for Suzu Lives' internal product-use assistant.
 *
 * This session is deliberately not a companion conversation: it must retain
 * a user's software goal and the outcome of product actions, but never turn
 * product support into a relationship or long-term memory record.
 */
export const DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT = `你正在把一段 Suzu Lives 软件使用助手对话整理成供后续操作使用的工作记录。下一位助手需要据此继续说明、导航或执行已授权的软件动作。

只输出这份工作记录本身；不要回复用户、不要提到压缩、不要添加寒暄或开场，也不要调用工具。使用简短 Markdown 小节；没有内容的小节直接省略。

按需使用以下结构：
## 目标
用户想完成的事情，以及已确认的完成标准。

## 已完成
已经执行的软件动作、已跳转页面及得到的结果。

## 当前状态
已经确认的设置、界面状态、非敏感模型名称、地址、参数或文件位置。

## 下一步
尚未完成的动作、需要用户补充的信息、阻塞原因和推荐的下一步。

只记录下一步真正会用到的事实和结论，合并重复内容。不要编造软件状态。
绝不记录 API Key、密码、令牌或其他密钥；不要记录系统提示、工具调用原文、报错堆栈或无关内部日志。
这是软件工作记录，不是陪伴记忆：不要写入人设、关系、情绪分析、长期记忆或联系人聊天内容。`;
