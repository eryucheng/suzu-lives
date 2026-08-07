import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro, status } from "../../components/panel.mjs";

function spaceCard(kind, title, detail, label, tone) {
  return '<button class="create-space-card" data-open-create-space="' + kind + '"><div class="create-space-card-top"><span class="create-space-symbol">' + (kind === "visual" ? "◌" : "〰") + "</span>" + status(label, tone) + '</div><div><h2>' + escapeHtml(title) + "</h2><p>" + escapeHtml(detail) + "</p></div><span class=\"create-space-enter\">进入</span></button>";
}

export function renderCreateOverview() {
  return pageIntro("CREATE", "创作", "把视觉灵感与声音方向整理成可以继续推进的创作现场。") + '<section class="create-space-grid">' + spaceCard("visual", "视觉工作台", "从提示词、参考资料到候选结果，在同一处收束一次视觉创作。", "进入创作", "ready") + spaceCard("audio", "音色设计", "描述、试听并保留适合当前创作的声音候选。", "进入创作", "ready") + "</section>";
}

export function bindCreateOverviewEvents({ setCreatePage }) {
  document.querySelectorAll("[data-open-create-space]").forEach((button) => button.addEventListener("click", () => setCreatePage(button.dataset.openCreateSpace)));
}
