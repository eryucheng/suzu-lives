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
 * The command palette deliberately indexes app destinations only. It never
 * inspects conversations, memories, files, or any other user-created text.
 */
export const SUZU_SEARCH_ITEMS = Object.freeze([
  item({ id: "today", title: "今天", detail: "页面 · 日程和今日事项", keywords: ["首页", "日历", "待办", "日程"], icon: "spark", target: { view: "today" }, featured: true }),
  item({ id: "relationships", title: "关系", detail: "页面 · 联系人与相处资料", keywords: ["联系人", "关系", "档案"], icon: "people", target: { view: "relationships" }, featured: true }),
  item({ id: "conversation", title: "联系人对话", detail: "关系 · 对话", keywords: ["聊天", "会话", "消息", "通话", "审批模式", "本地附件", "消息免打扰", "置顶", "标为未读"], icon: "people", target: { view: "relationships", relationshipPage: "conversation" }, featured: true }),
  item({ id: "long-term-memory", title: "长期记忆", detail: "关系 · 记忆大脑", keywords: ["记忆", "大脑", "回忆", "召回"], icon: "spark", target: { view: "relationships", relationshipPage: "memory" }, featured: true }),
  item({ id: "conversation-compactor", title: "记忆压缩器", detail: "关系 · 会话压缩", keywords: ["压缩", "摘要", "jsonl", "历史记录"], icon: "spark", target: { view: "relationships", relationshipPage: "compactor" } }),
  item({ id: "relationship-files", title: "相处资料", detail: "关系 · 资料文件", keywords: ["claude", "persona", "user", "markdown", "关系文件"], icon: "people", target: { view: "relationships", relationshipPage: "settings" } }),
  item({ id: "plans", title: "计划", detail: "页面 · 自动任务与定时计划", keywords: ["任务", "定时", "日程", "自动任务"], icon: "calendar", target: { view: "plans" }, featured: true }),
  item({ id: "create", title: "创造", detail: "页面 · 图片与音频创作", keywords: ["生成", "创作", "图片", "音频"], icon: "palette", target: { view: "create" }, featured: true }),
  item({ id: "create-visual", title: "图片创作", detail: "创造 · 视觉工作台", keywords: ["生图", "图片生成", "视觉", "画图"], icon: "palette", target: { view: "create", createPage: "visual" } }),
  item({ id: "create-audio", title: "音频创作", detail: "创造 · 音频工作台", keywords: ["声音", "语音", "音频", "配音"], icon: "palette", target: { view: "create", createPage: "audio" } }),
  item({ id: "capabilities", title: "能力", detail: "页面 · 功能与接入能力", keywords: ["功能", "工具", "skill", "mcp"], icon: "sliders", target: { view: "capabilities" }, featured: true }),
  item({ id: "wechat", title: "微信设置", detail: "能力 · 行动", keywords: ["微信", "手机", "投递", "绑定", "审批提醒"], icon: "people", target: { view: "capabilities", capabilityPage: "detail", capabilityCategory: "act", capabilityId: "wechat-connection" } }),
  item({ id: "proactive-contact", title: "主动关心", detail: "能力 · 陪伴", keywords: ["主动", "关心", "回访", "提醒"], icon: "spark", target: { view: "capabilities", capabilityPage: "category", capabilityCategory: "companion" } }),
  item({ id: "traveling-merchant", title: "远行商人", detail: "能力 · 陪伴", keywords: ["商人", "物品", "监控", "提醒"], icon: "spark", target: { view: "capabilities", capabilityPage: "category", capabilityCategory: "companion" } }),
  item({ id: "settings", title: "设置", detail: "设置 · 常规", keywords: ["偏好", "软件设置", "选项"], icon: "gear", target: { view: "settings", settingsTab: "general" }, featured: true }),
  item({ id: "appearance", title: "外观", detail: "设置 · 常规", keywords: ["主题", "浅色", "深色", "颜色"], icon: "gear", target: { view: "settings", settingsTab: "general" } }),
  item({ id: "software-update", title: "软件更新", detail: "设置 · 常规", keywords: ["更新", "版本", "下载", "安装"], icon: "gear", target: { view: "settings", settingsTab: "general" } }),
  item({ id: "data-storage", title: "数据存储位置", detail: "设置 · 数据", keywords: ["数据", "目录", "工作目录", "缓存", "迁移"], icon: "gear", target: { view: "settings", settingsTab: "data" } }),
  item({ id: "system-status", title: "系统状态检查", detail: "设置 · 数据", keywords: ["检查", "claude", "诊断", "文件"], icon: "gear", target: { view: "settings", settingsTab: "data" } }),
  item({ id: "hidden-contacts", title: "隐藏联系人", detail: "设置 · 隐私", keywords: ["隐私", "恢复联系人", "显示联系人"], icon: "people", target: { view: "settings", settingsTab: "privacy" } }),
  item({ id: "admin", title: "管理", detail: "管理 · Agent 与软件配置", keywords: ["管理员", "agent", "模型", "配置"], icon: "sliders", target: { view: "admin", adminTab: "agent" } }),
  item({ id: "api-services", title: "API 服务", detail: "管理 · API 服务", keywords: ["api", "密钥", "模型", "连接"], icon: "sliders", target: { view: "admin", adminTab: "api-services" } }),
  item({ id: "claude-code", title: "Claude Code", detail: "管理 · Claude Code", keywords: ["claude", "代码", "模型", "运行时"], icon: "sliders", target: { view: "admin", adminTab: "claude-code" } }),
  item({ id: "runtime", title: "运行时设置", detail: "管理 · Agent 运行时", keywords: ["运行时", "权限", "审批", "工具"], icon: "sliders", target: { view: "admin", adminTab: "runtime" } }),
  item({ id: "usage", title: "调用统计", detail: "管理 · 用量与费用", keywords: ["费用", "token", "用量", "账单", "统计"], icon: "sliders", target: { view: "admin", adminTab: "usage" } }),
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
