import {
  dateTime,
  escapeHtml,
  localDateTimeInput,
  money,
  startOfTodayInput,
} from "../../core/formatters.mjs";
import { isReady } from "../../core/state.mjs";
import { card, emptyBlock, status } from "../../components/panel.mjs";
import { icons } from "../shell/index.mjs";
import { usageAmountLabel, usageCostLabel } from "./usage-display.mjs";

function filteredTimeline(state) {
  const query = state.timelineQuery.trim().toLocaleLowerCase("zh-CN");
  return (state.data?.events || []).filter((event) => (
    (state.timelineFilter === "all" || event.source === state.timelineFilter)
    && (!query || [event.source, event.feature, event.model, event.turnPrompt, event.requestId].join("\n").toLocaleLowerCase("zh-CN").includes(query))
  ));
}

function eventRows(events, limit) {
  if (!events.length) return '<tr><td colspan="6"><div class="activity-empty">没有符合条件的已识别调用。</div></td></tr>';
  return events.slice(-limit).reverse().map((event) => `<tr><td>${escapeHtml(dateTime(event.timestamp))}</td><td>${escapeHtml(event.source)}</td><td>${escapeHtml(event.feature)}</td><td>${escapeHtml(event.model || "未知")}</td><td>${escapeHtml(usageAmountLabel(event.units))}</td><td>${escapeHtml(usageCostLabel(event))}</td></tr>`).join("");
}

function conversationRows(rows) {
  if (!rows.length) return '<div class="activity-empty">还没有可以归属到会话轮次的费用。</div>';
  return `<div class="conversation-list">${rows.slice(0, 100).map((item) => `<div class="conversation-card"><div><strong>${escapeHtml(item.prompt)}</strong><p>${escapeHtml(dateTime(item.firstAt))}${item.tools?.length ? ` · 工具：${escapeHtml(item.tools.join("、"))}` : ""}</p></div><span>${item.requestCount} 次请求</span><b>${money(item.amountCny)}</b></div>`).join("")}</div>`;
}

function renderPriceSettings(data) {
  const models = data?.priceCatalog?.models || [];
  return card("模型价格", "金额由原始 usage 与调用时间对应的价格计算。保存会写入价格历史，不会修改源码。", `<div class="price-model-list">${models.map((model) => `<article class="price-model-card" data-price-model="${escapeHtml(model.modelId)}"><div class="price-model-header"><div><h3>${escapeHtml(model.label)}</h3><p>${escapeHtml(model.provider)} · ${model.origin === "custom" ? "当前使用自定义价格" : "当前使用官方默认价"}</p></div>${status(model.origin === "custom" ? "自定义" : "官方默认", model.origin === "custom" ? "ready" : "muted")}</div><div class="price-rate-grid">${Object.entries(model.rateDefinitions || {}).map(([key, definition]) => `<label><span>${escapeHtml(definition.label)}</span><input class="setting-input price-rate-input" type="number" min="0" step="any" data-price-rate="${escapeHtml(key)}" value="${escapeHtml(model.rates?.[key] ?? 0)}"><small>${escapeHtml(definition.unitLabel)}</small></label>`).join("")}</div><div class="price-model-actions"><label>生效时间<input class="setting-input price-effective-input" type="datetime-local" value="${escapeHtml(model.origin === "custom" ? localDateTimeInput(model.effectiveFrom) : startOfTodayInput())}"></label><div>${model.customRevisionCount ? '<button class="secondary-button" data-reset-price>恢复官方默认</button>' : ""}<button class="primary-button" data-save-price>保存价格</button></div></div></article>`).join("")}</div>`);
}

export function renderUsage({ state }) {
  if (!isReady()) return emptyBlock(icons.spark, "等待本地费用数据", "创建并选择联系人后，Suzu 才会查找可识别的本地费用记录；没有记录不等于零费用。", '<button class="primary-button" data-open-contact-conversation>前往会话</button>');
  const { summary, sources = [], events = [] } = state.data;
  const filtered = filteredTimeline(state);
  return `<section class="usage-summary"><article class="metric-card"><span>今日估算</span><strong>${money(summary.today.amountCny)}</strong><p>${summary.today.requestCount} 次已识别调用</p></article><article class="metric-card"><span>本月估算</span><strong>${money(summary.month.amountCny)}</strong><p>按当前价格规则估算</p></article><article class="metric-card"><span>可统计来源</span><strong>${sources.filter((item) => item.tracked && item.status === "ready").length} / ${sources.length}</strong><p>没有记录不等于零费用</p></article></section>
    <details class="usage-scope"><summary><div><span class="reference-kicker">DETAILS</span><h2>费用统计范围</h2><p>按需查看已纳入统计的来源。</p></div><span class="usage-scope__control">查看 <b aria-hidden="true">⌄</b></span></summary><div class="usage-scope__content"><div class="source-card-list">${sources.map((source) => `<div class="source-card"><div><strong>${escapeHtml(source.name)}</strong><p>${escapeHtml(source.detail)}</p></div>${status(source.status === "ready" ? "已纳入统计" : source.status === "not-instrumented" ? "尚未纳入统计" : "未找到", source.status === "ready" ? "ready" : "warning")}</div>`).join("") || '<div class="activity-empty">尚无来源信息。</div>'}</div></div></details>
    ${card("调用流水", `最近扫描于 ${dateTime(state.data.scannedAt)}，共 ${events.length.toLocaleString("zh-CN")} 条已识别记录。`, `<div class="toolbar"><div class="filters"><button class="filter-button ${state.timelineFilter === "all" ? "active" : ""}" data-filter="all">全部</button>${[...new Set(events.map((event) => event.source))].map((source) => `<button class="filter-button ${state.timelineFilter === source ? "active" : ""}" data-filter="${escapeHtml(source)}">${escapeHtml(source)}</button>`).join("")}</div><input id="timelineSearch" class="search-input" type="search" placeholder="搜索模型、请求 ID、会话内容" value="${escapeHtml(state.timelineQuery)}"></div><div class="table-scroll"><table class="data-table"><thead><tr><th>时间</th><th>来源</th><th>类型</th><th>模型</th><th>用量</th><th>估算费用</th></tr></thead><tbody>${eventRows(filtered, 12_000)}</tbody></table></div>`)}
    ${card("会话费用", "一次用户输入可能触发多次模型请求和工具循环。", conversationRows(summary.conversations || []))}
    ${renderPriceSettings(state.data)}`;
}

export function bindUsageEvents({ api, refreshData, render, setNotice, state }) {
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.timelineFilter = button.dataset.filter;
    render();
  }));
  document.querySelector("#timelineSearch")?.addEventListener("input", (event) => {
    state.timelineQuery = event.target.value;
    clearTimeout(window.__timelineTimer);
    window.__timelineTimer = setTimeout(render, 120);
  });
  document.querySelectorAll("[data-save-price]").forEach((button) => button.addEventListener("click", async () => {
    const cardNode = button.closest("[data-price-model]");
    const model = state.data?.priceCatalog?.models?.find((item) => item.modelId === cardNode?.dataset.priceModel);
    const effectiveDate = new Date(cardNode?.querySelector(".price-effective-input")?.value);
    if (!model || !Number.isFinite(effectiveDate.getTime())) return setNotice("请填写有效的价格生效时间。");
    const rates = {};
    for (const input of cardNode.querySelectorAll("[data-price-rate]")) {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return setNotice("价格必须是大于或等于 0 的数字。");
      rates[input.dataset.priceRate] = value;
    }
    const effectiveFrom = effectiveDate.toISOString();
    const existing = Array.isArray(state.settings.priceRevisions) ? state.settings.priceRevisions : [];
    state.settings = await api.settings.update({
      priceRevisions: [
        ...existing.filter((item) => !(item.modelId === model.modelId && item.effectiveFrom === effectiveFrom)),
        { id: `custom:${model.modelId}:${effectiveFrom}`, modelId: model.modelId, effectiveFrom, label: "软件内自定义价格", rates },
      ],
    });
    await refreshData();
  }));
  document.querySelectorAll("[data-reset-price]").forEach((button) => button.addEventListener("click", async () => {
    const modelId = button.closest("[data-price-model]")?.dataset.priceModel;
    state.settings = await api.settings.update({ priceRevisions: (state.settings.priceRevisions || []).filter((item) => item.modelId !== modelId) });
    await refreshData();
  }));
}
