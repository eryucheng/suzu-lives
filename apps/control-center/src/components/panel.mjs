import { escapeHtml } from "../core/formatters.mjs";

export function status(label, tone = "muted") {
  return `<span class="status-pill status-${tone}">${escapeHtml(label)}</span>`;
}

export function pageIntro(eyebrow, title, subtitle, action = "") {
  return `<div class="page-intro"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${action}</div>`;
}

export function card(title, subtitle, body, extra = "") {
  return `<article class="panel ${extra}"><div class="panel-header"><div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div></div>${body}</article>`;
}

export function emptyBlock(icon, title, detail, action = "") {
  return `<article class="empty-panel"><div class="empty-symbol">${icon}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>${action}</article>`;
}
