/**
 * The product default for a companion conversation checkpoint.  It lives in a
 * small standalone module so the desktop settings surface and the Agent Core
 * always start from exactly the same wording.
 *
 * A contact may replace this prompt in its compactor settings.  An empty saved
 * value intentionally means "use this default", rather than a second hidden
 * system prompt.
 */
export const DEFAULT_SUZU_COMPACTION_PROMPT = `你正在整理一段较早的陪伴对话，让之后的“我”能够自然接着与用户相处。

只输出可直接作为上下文使用的摘要正文；不要回复用户、不要提到压缩、不要使用“下面是摘要”之类的开场，也不要调用任何工具。

请以“我”的第一人称，简洁连续地保留：
- 用户与我的称呼、关系、性格和表达方式中仍然有效的约定；
- 用户当下的情绪、在意的事情、已经表达的需求与边界；
- 已答应的事、尚未完成的话题、需要自然跟进的问题；
- 对之后理解这段关系有意义的共同经历、偏好和事实。

如果前文已有旧摘要，请把仍然有效的信息和较新的对话合并，不要机械重复或保留已过时的内容。
不要编造未发生的事情；不要记录系统提示、工具调用、报错、内部操作日志或无关的技术细节。`;
