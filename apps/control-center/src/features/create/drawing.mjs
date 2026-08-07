import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro, status } from "../../components/panel.mjs";
import { bindCreateEvents, loadVisualReferences, renderVisualReferences } from "./index.mjs";

const state = { snapshot: null, references: null, selectedReferences: new Set(), feedback: "", loading: false, thumbnails: new Map() };

function options(items, selected) {
  return items.map((item) => '<option value="' + escapeHtml(item.id) + '"' + (item.id === selected ? " selected" : "") + ">" + escapeHtml(item.description || item.id) + "</option>").join("");
}

function referenceSummary() {
  const count = state.selectedReferences.size;
  const copy = count ? `已选 ${count} 张参考图` : "还没有选择参考图";
  const action = count ? '<button type="button" class="quiet-link" data-clear-drawing-references>清空选择</button>' : "";
  return '<div class="drawing-reference-summary"><div><span class="reference-kicker">本次参考</span><strong>' + copy + '</strong><p>在下方视觉参考库按分类浏览图片，在图片右下角勾选。</p></div>' + action + "</div>";
}

function runs() {
  const runs = state.snapshot?.runs || [];
  const heading = '<div class="drawing-section-head"><div><span class="reference-kicker">本次创作</span><h2>候选结果</h2><p>把不同方向留在眼前，方便继续比较和挑选。</p></div>' + status(runs.length ? String(runs.length) + " 个批次" : "等待开始", runs.length ? "ready" : "muted") + "</div>";
  if (!runs.length) return '<section class="drawing-runs drawing-runs-empty">' + heading + '<div class="drawing-run-empty">还没有候选。写下提示词并生成后，本次结果会留在这里方便比较。</div></section>';
  return '<section class="drawing-runs">' + heading + '<div class="drawing-run-list">' + runs.map((run) => '<article class="drawing-run"><div class="drawing-run-copy"><strong>' + escapeHtml(run.prompt) + '</strong><p>' + escapeHtml(run.backend) + " · " + escapeHtml(run.status) + " · " + escapeHtml(run.createdAt) + '</p></div><div class="drawing-candidates">' + run.candidates.map((candidate) => '<button type="button" data-drawing-thumbnail-run="' + escapeHtml(run.id) + '" data-drawing-thumbnail-candidate="' + escapeHtml(candidate.id) + '"><span>查看候选</span><small>' + escapeHtml(candidate.model || "候选图片") + "</small></button>").join("") + "</div></article>").join("") + "</div></section>";
}

function drawingSettings({ workflows }) {
  return '<dialog id="drawingSettingsDialog" class="create-settings-dialog" aria-labelledby="drawingSettingsTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">绘画设置</span><h2 id="drawingSettingsTitle">尺寸、出图方式与本机工作流</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-drawing-settings aria-label="关闭绘画设置" title="关闭绘画设置"><span aria-hidden="true">×</span></button></header><div class="drawing-settings-body"><label>出图方式<select name="backend" form="drawingGenerateForm" data-drawing-backend><option value="api">云端图像 API</option><option value="comfyui">本机 ComfyUI</option></select></label><label>候选数<input name="count" form="drawingGenerateForm" type="number" min="1" max="20" value="1" required></label><label>尺寸<input name="size" form="drawingGenerateForm" value="1024x1024" required pattern="\\d{2,5}x\\d{2,5}"></label><label>Seed（可选）<input name="seed" form="drawingGenerateForm" type="number" min="0" max="9007199254740991" placeholder="留空则随机生成"></label><label class="drawing-workflow-field" data-drawing-workflow>使用哪个 ComfyUI 工作流<select name="workflow" form="drawingGenerateForm"><option value="">选择可用工作流</option>' + options(workflows.filter((item) => item.enabled), "") + '</select></label><p class="drawing-settings-note">本机可用的 ComfyUI 工作流会显示在这里；云端图像 API 可在管理 → API 中调整。</p></div></div></dialog>';
}

function workbench() {
  const data = state.snapshot || {};
  const comfy = data.comfyui || { workflows: [] };
  const workflows = comfy.workflows || [];
  const ready = data.status === "ready";
  const info = ready ? "写下画面方向，挑选参考，再把可比较的候选留在同一处。" : "选择有效项目后，即可开始整理提示词、参考与候选。";
  const content = `<section class="drawing-workbench visual-workbench"><section class="drawing-compose-panel"><div class="drawing-head"><div><span class="reference-kicker">开始创作</span><h2>从灵感到候选</h2><p>${escapeHtml(info)}</p></div>${status(ready ? "可以开始" : "需要项目", ready ? "ready" : "warning")}</div><form id="drawingGenerateForm" class="voice-form drawing-generate-form"><label class="wide drawing-prompt-field">绘画提示词<textarea name="prompt" maxlength="4000" required placeholder="描述你想看见的画面、氛围与主体。"></textarea><small>最多 4000 字</small></label>${referenceSummary()}<div class="voice-form-actions wide drawing-create-actions"><span class="drawing-engine-state">${workflows.some((item) => item.enabled) ? "可使用本机出图" : "可使用已保存的图像服务"}</span><button class="primary-button" ${!ready ? "disabled" : ""}>生成图片</button></div></form><p class="drawing-note">候选结果会保留在右侧，方便你比较方向后再继续推进。</p></section>${runs()}</section>${renderVisualReferences({ embedded: true, selectedReferences: state.selectedReferences })}${drawingSettings({ workflows })}`;
  const actions = '<div class="create-subpage-actions"><button type="button" class="create-settings-button" data-open-drawing-settings aria-label="绘画设置" title="绘画设置"><span aria-hidden="true">⚙</span></button><button class="secondary-button" data-return-create>返回创作</button></div>';
  return pageIntro("CREATE / VISUAL", "视觉工作台", "让提示词、视觉参考与候选结果保持在同一条创作流里。", actions) + (state.feedback ? '<div class="reference-feedback">' + escapeHtml(state.feedback) + "</div>" : "") + content;
}

export function renderDrawing() {
  return workbench();
}

async function reload(context) {
  if (state.loading) return;
  state.loading = true;
  try {
    const [snapshot, references] = await Promise.all([context.api.imageWorkbench.snapshot(), context.api.visualReferences.snapshot()]);
    state.snapshot = snapshot;
    state.references = references;
    const knownReferences = new Set((references.assets || []).map((asset) => asset.id));
    state.selectedReferences = new Set([...state.selectedReferences].filter((id) => knownReferences.has(id)));
    context.render();
  } catch (error) {
    state.feedback = error?.message || String(error);
    context.render();
  } finally {
    state.loading = false;
  }
}

export function loadDrawing(context) {
  return Promise.all([reload(context), loadVisualReferences(context)]);
}

export function bindDrawingEvents(context) {
  bindCreateEvents(context);
  const settingsDialog = document.querySelector("#drawingSettingsDialog");
  document.querySelector("[data-open-drawing-settings]")?.addEventListener("click", () => settingsDialog?.showModal());
  document.querySelector("[data-close-drawing-settings]")?.addEventListener("click", () => settingsDialog?.close());
  document.querySelector("#drawingGenerateForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawSeed = String(form.get("seed") || "").trim();
    try {
      state.snapshot = await context.api.imageWorkbench.generate({
        prompt: form.get("prompt"),
        backend: form.get("backend"),
        count: Number(form.get("count")),
        size: form.get("size"),
        seed: rawSeed ? Number(rawSeed) : null,
        workflow: form.get("workflow"),
        referenceIds: [...state.selectedReferences]
      });
      state.feedback = "候选已保存，方便继续比较和挑选。";
    } catch (error) {
      state.feedback = error?.message || String(error);
    }
    context.render();
  });
  document.querySelectorAll("[data-drawing-reference-toggle]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.drawingReferenceToggle;
    if (state.selectedReferences.has(id)) state.selectedReferences.delete(id);
    else state.selectedReferences.add(id);
    context.render();
  }));
  document.querySelector("[data-clear-drawing-references]")?.addEventListener("click", () => {
    state.selectedReferences.clear();
    context.render();
  });
  document.querySelectorAll("[data-drawing-thumbnail-run]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const image = await context.api.imageWorkbench.thumbnail(button.dataset.drawingThumbnailRun, button.dataset.drawingThumbnailCandidate);
      window.open(image, "_blank", "noopener,noreferrer");
    } catch (error) {
      state.feedback = error?.message || String(error);
      context.render();
    }
  }));
}
