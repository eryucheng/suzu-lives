/**
 * The product default for a companion conversation checkpoint.  It lives in a
 * small standalone module so the desktop settings surface and the Agent Core
 * always start from exactly the same wording.
 *
 * A contact may replace this prompt in its compactor settings.  An empty saved
 * value intentionally means "use this default", rather than a second hidden
 * system prompt.
 */
export const DEFAULT_SUZU_COMPACTION_PROMPT = `把较早的聊天整理成一段可供后续自然续接的关系记事。

用当前角色的第一人称，写成简洁、连贯的短文。这段记事会成为之后聊天的背景，请保留：
- 我和用户之间稳定的称呼、关系、身份、性格、说话方式和相处习惯；
- 仍在延续的话题、场景、氛围、在意的事情、期待与共同约定；
- 已经发生且仍有意义的经历、事实、偏好，以及已经完成或正在推进的事情；
- 下一次聊天值得自然接起的承诺、线索和下一步；
- 持续场景、故事或角色扮演中已经建立的设定、时间线、人物关系和当前状态。

如有较早的关系记事，将它与新内容融合为现在仍成立的版本。把重复内容归并为清楚的持续状态，让每一段都能为后续对话提供具体线索。

只依据聊天中已经明确的信息写作。输出这段关系记事本身，不加标题。`;
