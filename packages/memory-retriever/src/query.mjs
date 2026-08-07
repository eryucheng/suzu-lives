function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizedQueryKey(value) {
  return normalize(value).replace(/[\s，。！？、,.!?：:；;“”"'（）()【】\[\]]+/gu, "");
}

function validDateKey(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) return null;
  return date.toISOString().slice(0, 10);
}

function localDateKey(now, timeZone) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("now 不是有效时间。");
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return validDateKey(values.year, values.month, values.day);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function addDateKeyDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function mondayOfDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  return addDateKeyDays(dateKey, -((date.getUTCDay() + 6) % 7));
}

function chineseInteger(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  const ten = value.indexOf("十");
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : digits[value[ten - 1]];
    const ones = ten === value.length - 1 ? 0 : digits[value[ten + 1]];
    return Number.isFinite(tens) && Number.isFinite(ones) ? tens * 10 + ones : Number.NaN;
  }
  return digits[value] ?? Number.NaN;
}

function temporalResult(query, match, startDate, endDate = startDate, kind = "day") {
  return {
    matched: true,
    kind,
    expression: match[0],
    startDate,
    endDate,
    remainingQuery: `${query.slice(0, match.index)} ${query.slice(match.index + match[0].length)}`.trim(),
  };
}

export function resolveTemporalQuery(query, now = new Date(), timeZone = "Asia/Shanghai") {
  const text = String(query || "");
  const today = localDateKey(now, timeZone);
  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/u)
    || text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (match) {
    const date = validDateKey(match[1], match[2], match[3]);
    if (date) return temporalResult(text, match, date);
  }
  match = text.match(/(\d{1,2})月(\d{1,2})[日号]/u);
  if (match) {
    const date = validDateKey(today.slice(0, 4), match[1], match[2]);
    if (date) return temporalResult(text, match, date);
  }
  match = text.match(/(上上|上个|上|本|这|这个|下个|下)周末/u);
  if (match) {
    const offset = match[1].startsWith("上上") ? -2
      : match[1].startsWith("上") ? -1
        : match[1].startsWith("下") ? 1 : 0;
    const saturday = addDateKeyDays(mondayOfDateKey(today), offset * 7 + 5);
    return temporalResult(text, match, saturday, addDateKeyDays(saturday, 1), "range");
  }
  match = text.match(/(上上|上个|上|本|这|这个|下个|下)(?:周|星期|礼拜)([一二三四五六日天])/u);
  if (match) {
    const offset = match[1].startsWith("上上") ? -2
      : match[1].startsWith("上") ? -1
        : match[1].startsWith("下") ? 1 : 0;
    const weekday = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }[match[2]];
    return temporalResult(
      text,
      match,
      addDateKeyDays(mondayOfDateKey(today), offset * 7 + weekday),
    );
  }
  match = text.match(/(\d+|[一二两三四五六七八九十]+)天前/u);
  if (match) {
    const days = chineseInteger(match[1]);
    if (Number.isFinite(days) && days > 0) {
      return temporalResult(text, match, addDateKeyDays(today, -days));
    }
  }
  for (const [label, offset] of [
    ["大前天", -3],
    ["前天", -2],
    ["昨天", -1],
    ["今天", 0],
    ["明天", 1],
    ["后天", 2],
  ]) {
    match = text.match(new RegExp(label, "u"));
    if (match) return temporalResult(text, match, addDateKeyDays(today, offset));
  }
  return {
    matched: false,
    kind: null,
    expression: "",
    startDate: null,
    endDate: null,
    remainingQuery: text,
  };
}

function cleanActor(role, key) {
  return {
    role: String(role || "").trim(),
    key: String(key || "").trim(),
  };
}

function subjectPredicateMatches(text, pronoun) {
  const escaped = pronoun.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(`${escaped}(?:自己)?(?:上上周[一二三四五六日天]?|上周[一二三四五六日天]?|这周[一二三四五六日天]?|本周[一二三四五六日天]?|昨天|今天|前天|最近|以前|之前|现在|后来|当时|上次|曾经|平时|通常|一直|总是|有时|偶尔|最|更|比较|特别|非常|很|\\d{1,2}月|\\d{1,2}号|\\d{1,2}日|\\s){0,4}(?:喜欢|偏爱|讨厌|不喜欢|觉得|认为|相信|想要|计划|决定|答应|承诺|会|能|做过|干过|去过|吃过|看过|玩过|说过|经历过|住过|工作|学习|去了|去|做了|做|吃了|吃|看了|看|玩了|玩|说了|说|在|有)`, "gu"),
    new RegExp(`${escaped}(?:是)?怎么说(?:的|过)?`, "gu"),
    new RegExp(`${escaped}的(?:喜好|偏好|习惯|计划|目标|能力|经历|原话|观点|看法|想法|选择|工作|住址|生日)`, "gu"),
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => {
    const basis = match[0];
    const stateFocused = /(?:喜欢|偏爱|讨厌|不喜欢|觉得|认为|相信|想要|计划|决定|答应|承诺|喜好|偏好|习惯|目标|能力|观点|看法|想法)/u.test(basis);
    return {
      index: Number(match.index),
      basis,
      focus: stateFocused ? "state" : "event",
    };
  }));
}

export function resolveQuerySubject(query, {
  speakerRole = "user",
  speakerKey = "user",
  addresseeRole = "agent",
  addresseeKey = "",
} = {}) {
  const text = normalize(query);
  const speaker = cleanActor(speakerRole, speakerKey);
  const addressee = cleanActor(addresseeRole, addresseeKey);
  const none = (reason = "no-explicit-subject") => ({
    matched: false,
    mode: "none",
    role: "",
    key: "",
    basis: "",
    reason,
  });
  if (!text) return none("empty-query");
  if (/[“”"']/u.test(text)) return none("quoted-language");

  const conversationalFrame = /^(?:请)?你(?:还)?(?:记不记得|记得|知不知道|知道|能不能告诉我|告诉我|回忆一下|想不想得起来)(?:一下)?/u;
  const content = text.replace(conversationalFrame, "").trim();
  const matches = [
    ...subjectPredicateMatches(content, "我").map((match) => ({ ...match, actor: speaker })),
    ...subjectPredicateMatches(content, "你").map((match) => ({ ...match, actor: addressee })),
  ].sort((left, right) => right.index - left.index || right.basis.length - left.basis.length);
  if (matches.length) {
    const selected = matches[0];
    if (!selected.actor.role || !selected.actor.key) return none("perspective-missing-key");
    return {
      matched: true,
      mode: "personal",
      role: selected.actor.role,
      key: selected.actor.key,
      basis: selected.basis,
      focus: selected.focus,
      stateTime: selected.focus === "state" && /(?:以前|之前|过去|从前|曾经|当时|那时候|原来)/u.test(content)
        ? "historical"
        : selected.focus === "state" ? "current" : "not-applicable",
      reason: "explicit-subject-predicate",
    };
  }
  if (/(?:我们|咱们|咱俩|我们俩|一起)/u.test(content)) {
    if (!speaker.role || !speaker.key || !addressee.role || !addressee.key) {
      return none("perspective-missing-key");
    }
    return {
      matched: true,
      mode: "shared",
      role: "shared",
      key: "",
      basis: content.match(/(?:我们|咱们|咱俩|我们俩|一起)/u)?.[0] || "",
      reason: "explicit-shared-subject",
      members: [speaker, addressee],
    };
  }
  return none();
}

function isEvidenceReviewText(text) {
  return /(?:你(?:能)?确定|有(?:没有)?把握|靠不靠谱|可不可靠|是否可靠|可靠吗|可信(?:吗|不)|准确(?:吗|不)|这个判断准(?:吗|不)|(?:有|存在|有没有|还有没有)(?:什么)?例外|是否有例外|有什么漏洞)/u.test(text);
}

export function classifyRecallIntent(query) {
  const text = normalize(query);
  if (isEvidenceReviewText(text)) {
    return "evidence-review";
  }
  if (/(?:反证|反例|相反(?:的)?(?:依据|证据)|不支持(?:这个|这一|该)?(?:结论|判断|看法)?(?:的)?(?:依据|证据))/u.test(text)) {
    return "counterevidence";
  }
  if (/(?:依据|证据|怎么(?:知道|判断|得出)|凭什么|(?:你)?为什么(?:会)?(?:觉得|认为|判断|说))/u.test(text)) {
    return "evidence";
  }
  if (/(?:原话|哪句话|那句话|怎么说的|说过什么|当时说了什么|原句)/u.test(text)) {
    return "utterance";
  }
  if (/(?:那件事|这件事|发生了什么|后来|结果|经过|那次|上次|当时|以前|之前|记得|回忆|什么时候|哪天|几号|去过|来过)/u.test(text)) {
    return "event";
  }
  return "auto";
}

export function classifyRepresentationIntent(query) {
  const text = normalize(query);
  if (
    isEvidenceReviewText(text)
    || /(?:你|系统)(?:是)?(?:为什么|为何|怎么)(?:会)?(?:觉得|认为|判断|推断)|(?:你|系统)根据什么(?:判断|推断|得出)|为什么会被(?:判断|推断|认为)/u.test(text)
  ) {
    return "evaluated";
  }
  return "any";
}

export function classifyChainIntent(query, temporal = { matched: false, remainingQuery: "" }) {
  const text = normalize(query);
  if (isEvidenceReviewText(text)) {
    return { mode: "none", direction: "both" };
  }
  if (/(?:反证|反例|相反(?:的)?(?:依据|证据)|不支持(?:这个|这一|该)?(?:结论|判断|看法)?(?:的)?(?:依据|证据)|依据|证据|怎么(?:知道|判断|得出)|凭什么|(?:你)?为什么(?:会)?(?:觉得|认为|判断|说)|原话|哪句话|那句话|怎么说的|说过什么|原句)/u.test(text)) {
    return { mode: "none", direction: "both" };
  }
  if (/(?:为什么|为何|怎么会|原因(?:是什么|呢)?|什么(?:原因|导致|造成|引起)|由什么(?:导致|造成|引起))/u.test(text)) {
    return { mode: "causal", direction: "backward" };
  }
  if (/(?:导致(?:了)?什么|造成(?:了)?什么|引起(?:了)?什么|带来(?:了)?什么(?:后果|影响)?|有什么(?:后果|影响)|产生(?:了)?什么(?:后果|影响))/u.test(text)) {
    return { mode: "causal", direction: "forward" };
  }
  if (/(?:还(?:会|能|让你)?想起|联想到|相关的|类似的|还有哪些|还有什么|还有呢|再说点|再说一点)/u.test(text)) {
    return { mode: "associative", direction: "both" };
  }
  const backward = /(?:^(?:再)?(?:往前|之前|前面)(?:呢|发生了什么)?$|在这之前|在那之前|此前|前面发生|之前发生|前因)/u.test(text);
  const forward = /(?:后来|之后|接着|然后|结果|后续|发展下去|接下来)/u.test(text);
  const whole = /(?:整个经过|完整经过|从头|前因后果|来龙去脉|前后发生)/u.test(text);
  if (whole || backward || forward) {
    return {
      mode: "timeline",
      direction: whole || (backward && forward) ? "both" : backward ? "backward" : "forward",
    };
  }
  if (temporal.matched && !recallCorePhrases(temporal.remainingQuery).length) {
    return { mode: "date", direction: "both" };
  }
  return { mode: "none", direction: "both" };
}

const DEFAULT_GENERIC_QUERIES = Object.freeze([
  "在吗", "嗯", "嗯嗯", "好", "好的", "好吧", "行", "知道了", "算了",
  "继续", "然后呢", "你呢", "怎么了", "哈哈", "睡了", "几点了", "现在几点", "现在几点了",
]);

export function isGenericQuery(query, genericQueries = DEFAULT_GENERIC_QUERIES) {
  const key = normalizedQueryKey(query);
  if (!key) return true;
  return new Set(genericQueries.map(normalizedQueryKey)).has(key);
}

export function recallCorePhrases(query) {
  let text = normalize(query).replace(/[，。！？、,.!?：:；;“”"'（）()【】\[\]]+/gu, " ");
  for (const phrase of [
    "做了些什么", "干了些什么", "做了什么", "干了什么", "发生了什么", "有什么事情",
    "有什么事", "干啥了", "做啥了", "干什么", "做什么", "去了哪里", "去哪里了",
    "当时说了什么", "原话怎么说", "说过什么关于", "说过什么", "我是怎么说的", "我怎么说的", "怎么说的", "你为什么会觉得", "你为什么觉得", "为什么会觉得", "为什么觉得", "你为什么会认为", "你为什么认为", "为什么会认为", "为什么认为", "为什么会判断", "为什么判断", "为什么会说", "为什么说", "为什么会", "为什么", "为何", "怎么会",
    "有什么相反依据", "有什么相反证据", "有什么反证", "有什么反例", "相反依据", "相反证据", "反证", "反例", "有什么依据", "有什么证据", "依据是什么", "证据是什么", "怎么知道的", "怎么判断的", "怎么得出的", "凭什么", "依据", "证据",
    "你能确定", "你确定", "有没有把握", "有把握", "靠不靠谱", "可不可靠", "是否可靠", "可靠吗", "可信吗", "准确吗", "这个判断准吗", "还有没有什么例外", "有没有什么例外", "还有没有例外", "有没有例外", "是否有例外", "存在例外", "有什么漏洞",
    "是什么原因", "什么原因", "原因是什么", "由什么导致", "什么导致", "原因", "导致", "什么时候",
    "造成了什么后果", "造成什么后果", "造成了什么影响", "造成什么影响", "造成了什么", "造成什么",
    "引起了什么后果", "引起什么后果", "引起了什么影响", "引起什么影响", "引起了什么", "引起什么",
    "带来了什么后果", "带来什么后果", "带来了什么影响", "带来什么影响", "产生了什么后果", "产生什么后果", "产生了什么影响", "产生什么影响", "有什么后果", "有什么影响",
    "还记不记得", "还记得", "记不记得", "那件事情", "这件事情", "那件事", "这件事",
    "多久以前", "多久之前", "哪一天", "哪天", "几号", "上一次", "上次", "那一次", "那次",
    "那句话", "这句话", "那一句", "这一句", "那句", "这句",
    "之前", "以前", "当时", "后来", "结果", "经过", "记得", "回忆", "发生", "原话", "关于", "的话",
  ]) text = text.replaceAll(phrase, " ");
  return text.split(/\s+/u)
    .map((part) => part
      .replace(/^(?:我|你|他|她|它|我们|你们|他们|还|曾经|到底)+(?:有)?/u, "")
      .replace(/^(?:去过|去)/u, "")
      .replace(/(?:是什么|是|的|吗|呢|啊|呀|吧|了)+$/u, "")
      .trim())
    .filter((part) => Array.from(part).length >= 2);
}

const STOP_CHARACTERS = new Set("我你他她它的是了在和也就都还又把被有去来吗呢啊呀吧这那".split(""));

export function lexicalTerms(value) {
  const text = normalize(value);
  const terms = new Set();
  for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const sequence = match[0];
    for (const width of [2, 3, 4]) {
      for (let index = 0; index + width <= sequence.length; index += 1) {
        const token = sequence.slice(index, index + width);
        if (![...token].every((character) => STOP_CHARACTERS.has(character))) terms.add(token);
      }
    }
  }
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_.-]*/gu)) terms.add(match[0]);
  return [...terms];
}

export function lexicalScore(query, document) {
  const phrases = recallCorePhrases(query);
  const queryText = phrases.length ? phrases.join(" ") : query;
  const queryTerms = lexicalTerms(queryText);
  const normalizedDocument = normalize(document).replace(/\s+/gu, "");
  let score = 0;
  let overlap = 0;
  const matchedTerms = [];
  for (const term of queryTerms) {
    if (!normalizedDocument.includes(term)) continue;
    overlap += 1;
    matchedTerms.push(term);
    score += Math.max(1, Array.from(term).length - 1);
  }
  const normalizedQuery = normalize(queryText).replace(/[^\p{L}\p{N}]+/gu, "");
  const exactPhrase = normalizedQuery.length >= 2 && normalizedDocument.includes(normalizedQuery);
  if (exactPhrase) score += 8;
  return { score, overlap, exactPhrase, queryTerms, matchedTerms };
}

export function isContinuationQuery(query) {
  const key = normalizedQueryKey(query);
  if (!key || key.length > 18) return false;
  return [
    /^(?:后来|之后|然后|接着|结果|后续)(?:呢|怎么样|发生了什么)?$/u,
    /^(?:再)?(?:往后|往前|之前|前面)(?:呢|发生了什么)?$/u,
    /^(?:还有呢|还有什么|再说点|再说一点)$/u,
    /^(?:那|这)(?:件事|件事情|一次|次|个)?(?:后来|之后|然后|结果|前面|之前|原话)?(?:呢|怎么样|怎么说的)?$/u,
    /^(?:为什么|为何|怎么会|什么原因|原因(?:是什么|呢)?)$/u,
    /^(?:那|这)?(?:有|还有)?(?:什么)?(?:依据|证据)(?:呢|吗)?$/u,
    /^(?:那|这)?(?:有|还有)?(?:什么)?(?:反证|反例|相反(?:的)?(?:依据|证据))(?:呢|吗)?$/u,
    /^(?:那|这|这个判断|这个结论)?(?:你)?(?:能)?(?:确定|有把握|靠不靠谱|可不可靠|是否可靠|可靠|可信|准确|准|有没有例外|是否有例外|存在例外|有什么漏洞)(?:呢|吗)?$/u,
    /^(?:那|这)?(?:是)?怎么(?:知道|判断|得出)(?:的)?$/u,
    /^(?:那|这)?凭什么$/u,
    /^(?:那|这)?(?:当时)?(?:具体)?(?:怎么说的|说了什么|原话(?:呢|是什么)?)$/u,
    /^(?:那|这|这件事|那件事)?(?:后来)?(?:导致|造成|引起)(?:了)?什么(?:后果|影响)?$/u,
    /^(?:那|这|这件事|那件事)?(?:有|产生|带来)(?:了)?什么(?:后果|影响)$/u,
  ].some((pattern) => pattern.test(key));
}

function continuationIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

export function resolveContinuationAnchors(query, trace = {}) {
  if (!isContinuationQuery(query)) {
    return {
      memoryIds: [],
      focusRole: "none",
      reason: "not-continuation",
      sourceTraceId: "",
    };
  }

  const metadata = trace?.metadata && typeof trace.metadata === "object"
    ? trace.metadata
    : {};
  const typed = metadata.continuationFocuses
    && typeof metadata.continuationFocuses === "object"
    ? metadata.continuationFocuses
    : null;
  const sourceTraceId = String(trace?.id ?? "").trim();
  const legacyMemoryIds = continuationIds([
    metadata.continuationMemoryId,
    metadata.focusMemoryId,
    trace?.selectedIds?.at?.(-1),
  ]).slice(0, 1);

  if (!typed) {
    return {
      memoryIds: legacyMemoryIds,
      focusRole: legacyMemoryIds.length ? "legacy" : "none",
      reason: legacyMemoryIds.length ? "legacy-single-focus" : "no-focus",
      sourceTraceId,
    };
  }

  const primaryMemoryId = continuationIds(typed.primaryMemoryId)[0] || "";
  const chainMemoryId = continuationIds(typed.chainMemoryId)[0] || primaryMemoryId;
  const representationMemoryIds = continuationIds(typed.representationMemoryIds);
  const recallIntent = classifyRecallIntent(query);
  const representationIntent = classifyRepresentationIntent(query);
  const chainIntent = classifyChainIntent(query);

  if (representationIntent === "evaluated" && representationMemoryIds.length) {
    return {
      memoryIds: continuationIds([primaryMemoryId, ...representationMemoryIds]).slice(0, 3),
      focusRole: "representation-set",
      reason: "evaluated-representation-follow-up",
      sourceTraceId,
    };
  }
  if (["evidence", "counterevidence", "evidence-review", "utterance"].includes(recallIntent)) {
    const memoryIds = continuationIds(primaryMemoryId || legacyMemoryIds[0]).slice(0, 1);
    return {
      memoryIds,
      focusRole: memoryIds.length ? "primary" : "none",
      reason: memoryIds.length ? `${recallIntent}-primary-follow-up` : "no-focus",
      sourceTraceId,
    };
  }
  if (["timeline", "causal", "associative"].includes(chainIntent.mode)) {
    const memoryIds = continuationIds(chainMemoryId || legacyMemoryIds[0]).slice(0, 1);
    return {
      memoryIds,
      focusRole: memoryIds.length ? "chain-tail" : "none",
      reason: memoryIds.length ? `${chainIntent.mode}-chain-follow-up` : "no-focus",
      sourceTraceId,
    };
  }
  const memoryIds = continuationIds(primaryMemoryId || legacyMemoryIds[0]).slice(0, 1);
  return {
    memoryIds,
    focusRole: memoryIds.length ? "primary" : "none",
    reason: memoryIds.length ? "generic-primary-follow-up" : "no-focus",
    sourceTraceId,
  };
}
