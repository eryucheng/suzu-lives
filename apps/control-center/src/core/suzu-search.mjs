const DEFAULT_LIMIT = 24;
const FEATURED_LIMIT = 9;

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLocaleLowerCase();
}

function item({ detail, featured = false, icon, id, keywords = [], target, title }) {
  return Object.freeze({
    detail: clean(detail),
    featured: featured === true,
    icon: clean(icon),
    id: clean(id),
    keywords: Object.freeze(keywords.map(clean).filter(Boolean)),
    target: Object.freeze({ ...(target || {}) }),
    title: clean(title),
  });
}

/**
 * Product destination catalog. The old command palette used this list
 * directly; the built-in software assistant now uses the same canonical
 * entries as its manual and navigation action source. It never inspects
 * conversations, memories, files, or other user-created text.
 */
export const SUZU_SEARCH_ITEMS = Object.freeze([
  item({ id: "today", title: "今天", detail: "页面 · 日历与重要日期", keywords: ["首页", "日历", "日期", "纪念日", "节日", "日程"], icon: "spark", target: { view: "today" }, featured: true }),
  item({ id: "conversation", title: "聊天", detail: "联系人 · 对话", keywords: ["会话", "消息", "联系人", "本地附件", "消息免打扰", "置顶", "标为未读"], icon: "chat", target: { view: "relationships", relationshipPage: "conversation" }, featured: true }),
  item({ id: "conversation-compactor", title: "上下文整理", detail: "联系人 · Agent Core 原生压缩", keywords: ["压缩", "摘要", "rewind", "上下文", "会话整理"], icon: "spark", target: { view: "relationships", relationshipPage: "compactor" } }),
  item({ id: "agent-journal", title: "查看日记", detail: "联系人 · Agent 每日回顾", keywords: ["日记", "写日记", "每日回顾", "agent 日记"], icon: "spark", target: { view: "relationships", relationshipPage: "journal" } }),
  item({ id: "memory", title: "长期记忆", detail: "联系人 · 召回、查看与维护", keywords: ["记忆", "召回", "memory", "长期", "记忆库", "大脑"], icon: "people", target: { view: "relationships", relationshipPage: "memory" } }),
  item({ id: "relationship-files", title: "相处设定", detail: "联系人 · SUZU.md 与资料", keywords: ["suzu", "persona", "user", "markdown", "关系文件", "人设"], icon: "people", target: { view: "relationships", relationshipPage: "settings" }, featured: true }),
  item({ id: "plans", title: "计划", detail: "软件 · 定时任务与自动计划", keywords: ["任务", "定时", "日程", "cron", "计划"], icon: "calendar", target: { view: "plans" } }),
  item({ id: "create", title: "创造", detail: "软件 · 图片工作台、视觉参考与声音设计", keywords: ["创造", "图片", "图片生成", "生图", "视觉", "参考图", "音色", "声音", "视频"], icon: "palette", target: { view: "create" }, featured: true }),
  item({ id: "capabilities", title: "能力", detail: "软件 · 感知、陪伴、行动与创作能力", keywords: ["能力", "插件", "安装", "功能", "skill", "mcp"], icon: "sliders", target: { view: "capabilities" }, featured: true }),
  item({ id: "voice-message", title: "语音消息", detail: "能力 · TTS、ASR、音色与语音通话设置", keywords: ["语音", "tts", "asr", "音色", "声音", "通话", "语音通话"], icon: "sliders", target: { view: "capabilities", capabilityPage: "detail", capabilityCategory: "create", capabilityId: "voice-message" } }),
  item({ id: "image-vision", title: "图像理解", detail: "能力 · 图片理解 API 与读取偏好", keywords: ["图像理解", "图片理解", "看图", "识图"], icon: "sliders", target: { view: "capabilities", capabilityPage: "detail", capabilityCategory: "perceive", capabilityId: "image-vision" } }),
  item({ id: "video-understanding", title: "视频理解", detail: "能力 · 直接把完整视频交给模型", keywords: ["视频理解", "看视频", "视频", "阿里视频"], icon: "sliders", target: { view: "capabilities", capabilityPage: "detail", capabilityCategory: "perceive", capabilityId: "video-understanding" } }),
  item({ id: "time-awareness", title: "时间感知", detail: "能力 · 联系人的动态时间上下文间隔", keywords: ["时间感知", "时间", "间隔", "10分钟"], icon: "sliders", target: { view: "capabilities", capabilityPage: "detail", capabilityCategory: "perceive", capabilityId: "time-awareness" } }),
  item({ id: "settings", title: "设置", detail: "软件 · 常规", keywords: ["偏好", "软件设置", "选项"], icon: "gear", target: { view: "settings", settingsTab: "general" }, featured: true }),
  item({ id: "appearance", title: "外观", detail: "设置 · 常规", keywords: ["主题", "浅色", "深色", "颜色"], icon: "gear", target: { view: "settings", settingsTab: "general" } }),
  item({ id: "software-update", title: "软件更新", detail: "设置 · 常规", keywords: ["更新", "版本", "下载", "安装"], icon: "gear", target: { view: "settings", settingsTab: "general" } }),
  item({ id: "api-connections", title: "API 连接", detail: "设置 · API 备注、地址与密钥", keywords: ["api", "接口", "key", "密钥", "base url", "服务地址", "中转", "连接"], icon: "gear", target: { view: "settings", settingsTab: "api" }, featured: true }),
  item({ id: "data-storage", title: "数据存储位置", detail: "设置 · 数据", keywords: ["数据", "目录", "工作目录", "缓存", "迁移"], icon: "gear", target: { view: "settings", settingsTab: "data" } }),
  item({ id: "system-status", title: "系统状态检查", detail: "设置 · 数据", keywords: ["检查", "agent", "诊断", "文件"], icon: "gear", target: { view: "settings", settingsTab: "data" } }),
  item({ id: "hidden-contacts", title: "隐藏联系人", detail: "设置 · 隐私", keywords: ["隐私", "恢复联系人", "显示联系人"], icon: "people", target: { view: "settings", settingsTab: "privacy" } }),
  item({ id: "identity", title: "我的资料", detail: "管理 · 名称、头像与签名", keywords: ["我", "身份", "头像", "昵称", "签名", "资料"], icon: "people", target: { view: "admin", adminTab: "agent" } }),
  item({ id: "main-model", title: "主模型", detail: "设置 · 文本模型连接与默认选择", keywords: ["agent", "deepseek", "minimax", "百炼", "kimi", "模型", "密钥", "连接", "主模型"], icon: "sliders", target: { view: "settings", settingsTab: "main-model" }, featured: true }),
  item({ id: "usage", title: "用量与成本", detail: "管理 · 调用流水与价格", keywords: ["费用", "成本", "价格", "token", "用量", "账单"], icon: "sliders", target: { view: "admin", adminTab: "usage" } }),
]);

const itemsById = new Map(SUZU_SEARCH_ITEMS.map((entry) => [entry.id, entry]));

function matchScore(entry, query) {
  const title = normalized(entry.title);
  const detail = normalized(entry.detail);
  const keywords = entry.keywords.map(normalized);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (keywords.some((keyword) => keyword === query)) return 2;
  if (title.includes(query)) return 3;
  if (keywords.some((keyword) => keyword.startsWith(query))) return 4;
  if (keywords.some((keyword) => keyword.includes(query))) return 5;
  if (detail.includes(query)) return 6;
  return Number.POSITIVE_INFINITY;
}

export function getSuzuSearchItem(id) {
  return itemsById.get(clean(id)) || null;
}

export function searchSuzuSearchItems(query = "", { limit = DEFAULT_LIMIT } = {}) {
  const normalizedQuery = normalized(query);
  const maximum = Math.max(1, Math.min(DEFAULT_LIMIT, Math.trunc(Number(limit) || DEFAULT_LIMIT)));
  if (!normalizedQuery) return SUZU_SEARCH_ITEMS.filter((entry) => entry.featured).slice(0, Math.min(FEATURED_LIMIT, maximum));
  return SUZU_SEARCH_ITEMS
    .map((entry, index) => ({ entry, index, score: matchScore(entry, normalizedQuery) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || Number(right.entry.featured) - Number(left.entry.featured) || left.index - right.index)
    .slice(0, maximum)
    .map(({ entry }) => entry);
}
