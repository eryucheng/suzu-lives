import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro, status } from "../../components/panel.mjs";

const roles = { identity: "人物", location: "地点", object: "物品", style: "风格" };
const viewState = { library: null, selectedId: "", role: "all", set: "all", pending: null, feedback: "", thumbnails: new Map(), loading: false };

function textLines(value) { return String(value || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean); }
function option(value, label, selected) { return '<option value="' + escapeHtml(value) + '"' + (value === selected ? " selected" : "") + ">" + escapeHtml(label) + "</option>"; }
function roleOptions(selected) { return Object.entries(roles).map(([id, label]) => option(id, label, selected)).join(""); }
function selectedAsset() { return viewState.library?.assets.find((asset) => asset.id === viewState.selectedId) || null; }
function setChecks(asset) {
  const sets = viewState.library?.sets || [];
  if (!sets.length) return '<p class="reference-form-hint">还没有分组；可先在下方创建分组。</p>';
  return sets.map((item) => '<label class="reference-set-check"><input type="checkbox" name="sets" value="' + escapeHtml(item.id) + '"' + (asset?.sets.includes(item.id) ? " checked" : "") + "><span>" + escapeHtml(item.description) + "</span><small>" + escapeHtml(item.id) + "</small></label>").join("");
}
function tile(asset, { selectedReferences = null } = {}) {
  const preview = viewState.thumbnails.get(asset.id);
  const chosenForDrawing = selectedReferences?.has(asset.id) || false;
  const chooseControl = selectedReferences
    ? '<button type="button" class="reference-select-square ' + (chosenForDrawing ? "selected" : "") + '" data-drawing-reference-toggle="' + escapeHtml(asset.id) + '" aria-pressed="' + chosenForDrawing + '" aria-label="' + escapeHtml(chosenForDrawing ? "取消选择“" + asset.description + "”作为本次参考" : "选择“" + asset.description + "”作为本次参考") + '" title="' + escapeHtml(chosenForDrawing ? "取消选择" : "选择作为本次参考") + '"><span aria-hidden="true">' + (chosenForDrawing ? "✓" : "") + "</span></button>"
    : "";
  return '<article class="reference-card ' + (chosenForDrawing ? "reference-card--chosen" : "") + '"><button class="reference-tile ' + (asset.id === viewState.selectedId ? "selected" : "") + '" data-select-reference="' + escapeHtml(asset.id) + '" aria-pressed="' + (asset.id === viewState.selectedId) + '"><div class="reference-preview">' + (preview ? '<img src="' + preview + '" alt="">' : "<span>缩略图加载中</span>") + '</div><div class="reference-tile-copy"><span class="reference-role">' + escapeHtml(roles[asset.role]) + "</span><strong>" + escapeHtml(asset.description) + "</strong><small>" + escapeHtml(asset.id) + "</small></div></button>" + chooseControl + "</article>";
}
function collection({ selectedReferences = null } = {}) {
  if (!viewState.library) return '<section class="reference-empty"><h2>正在读取视觉参考库</h2><p>请稍候，资料会显示在这里。</p></section>';
  if (viewState.library.status === "invalid") return '<section class="reference-empty reference-error"><h2>资料库暂时无法打开</h2><p>请稍后重试，或检查资料库设置。</p></section>';
  const assets = viewState.library.assets.filter((asset) => (viewState.role === "all" || asset.role === viewState.role) && (viewState.set === "all" || asset.sets.includes(viewState.set)));
  if (!assets.length) return '<section class="reference-empty"><h2>' + (viewState.library.assets.length ? "没有匹配的参考资料" : "资料库还是空的") + "</h2><p>" + (viewState.library.assets.length ? "调整角色或分组筛选，或从本机添加图片。" : "从本机添加第一张图片，建立这次创作的起点。") + "</p></section>";
  return '<div class="reference-grid">' + assets.map((asset) => tile(asset, { selectedReferences })).join("") + "</div>";
}
function filters() {
  const roleItems = [["all", "全部"], ...Object.entries(roles)];
  const setItems = [["all", "全部分组"], ...(viewState.library?.sets || []).map((item) => [item.id, item.description])];
  return '<div class="reference-filters"><div class="filter-row"><span>角色</span>' + roleItems.map(([id, label]) => '<button class="filter-button ' + (viewState.role === id ? "active" : "") + '" data-reference-role-filter="' + escapeHtml(id) + '">' + escapeHtml(label) + "</button>").join("") + '</div><label class="reference-group-filter">分组<select data-reference-set-filter>' + setItems.map(([id, label]) => option(id, label, viewState.set)).join("") + "</select></label></div>";
}
function importPanel({ embedded = false } = {}) {
  const empty = !viewState.library?.assets?.length;
  const open = !embedded || Boolean(viewState.pending) || empty;
  const content = !viewState.pending
    ? '<div class="reference-import-panel-content"><div><span class="reference-kicker">本机图片</span><h2>添加一张参考资料</h2><p>从本机挑选图片，为它补充准确的描述、角色与分组。</p></div><div class="reference-import-start"><label>角色<select id="referenceRole">' + roleOptions("identity") + '</select></label><button class="primary-button" data-select-local-reference>从本机选择图片</button></div></div>'
    : '<div class="reference-import-panel-content reference-import-ready"><div><span class="reference-kicker">已选择</span><h2>' + escapeHtml(viewState.pending.fileName) + '</h2><p>补充资料后保存到视觉参考库，方便下一次创作继续使用。</p></div><form id="referenceImportForm" class="reference-form"><label>资料 ID<input name="id" value="' + escapeHtml(viewState.pending.candidateId) + '" maxlength="120" required pattern="[a-z0-9.-]+"></label><label>角色<select name="role">' + roleOptions(viewState.pending.role) + '</select></label><label class="wide">描述<textarea name="description" required maxlength="2000" placeholder="写下这张图片实际呈现的内容。"></textarea></label><label>保留特征（一行一项）<textarea name="preserve" placeholder="例如：脸型"></textarea></label><label>忽略特征（一行一项）<textarea name="ignore" placeholder="例如：背景"></textarea></label><fieldset class="wide"><legend>所属分组</legend>' + setChecks(null) + '</fieldset><div class="reference-form-actions wide"><button type="button" class="secondary-button" data-cancel-reference-import>取消</button><button class="primary-button">导入到资料库</button></div></form></div>';
  return '<details class="reference-import-panel"' + (open ? " open" : "") + '><summary><span><span class="reference-kicker">添加资料</span><strong>补充视觉参考</strong></span><span class="reference-detail-summary-note">从本机选择图片</span></summary>' + content + "</details>";
}
function detail({ embedded = false } = {}) {
  const asset = selectedAsset();
  if (!asset) return embedded ? "" : '<aside class="reference-detail reference-detail-empty"><span class="reference-kicker">资料详情</span><h2>选择一张资料</h2><p>选择缩略图后，可在这里补充描述、特征和分组。</p></aside>';
  return `<details class="reference-detail reference-inspector" open><summary><span><span class="reference-kicker">已选资料 · ${escapeHtml(roles[asset.role])}</span><strong>${escapeHtml(asset.description)}</strong></span>${status("查看与编辑", "ready")}</summary><div class="reference-detail-body"><div class="reference-detail-head"><div><span class="reference-kicker">资料信息</span><h2>${escapeHtml(asset.id)}</h2></div></div><form id="referenceDetailForm" class="reference-form"><label>角色<select name="role">${roleOptions(asset.role)}</select></label><label>资料 ID<input value="${escapeHtml(asset.id)}" disabled></label><label class="wide">描述<textarea name="description" required maxlength="2000">${escapeHtml(asset.description)}</textarea></label><label>保留特征（一行一项）<textarea name="preserve">${escapeHtml(asset.preserve.join("\n"))}</textarea></label><label>忽略特征（一行一项）<textarea name="ignore">${escapeHtml(asset.ignore.join("\n"))}</textarea></label><fieldset class="wide"><legend>所属分组</legend>${setChecks(asset)}</fieldset><div class="reference-form-actions wide"><button class="primary-button">保存修改</button></div></form><div class="reference-danger-zone"><strong>移除资料</strong><p>“移除资料库”只删除登记；“删除软件内副本”会同时删除复制到 Suzu Lives 数据目录的图片。</p><div><button class="secondary-button" data-remove-reference="keep">从资料库移除</button><button class="danger-button" data-remove-reference="delete">同时删除软件内副本</button></div></div></div></details>`;
}
function groups({ embedded = false } = {}) {
  const values = viewState.library?.sets || [];
  const list = values.length ? values.map((item) => '<article><strong>' + escapeHtml(item.description) + "</strong><small>" + escapeHtml(item.id) + " · " + item.assets.length + ' 项</small><button class="quiet-link" data-remove-reference-set="' + escapeHtml(item.id) + '">移除分组</button></article>').join("") : '<p class="reference-form-hint">尚无分组。</p>';
  return `<details class="reference-groups"${embedded ? "" : " open"}><summary><span><span class="reference-kicker">分组</span><strong>组织一组参考</strong></span><span class="reference-detail-summary-note">${values.length} 个分组</span></summary><div class="reference-groups-content"><div class="reference-group-list">${list}</div><form id="referenceSetForm" class="reference-set-form"><input name="id" maxlength="120" required pattern="[a-z0-9.-]+" placeholder="分组 ID，例如 character-main"><input name="description" maxlength="2000" required placeholder="分组说明"><button class="secondary-button">创建 / 更新分组</button></form></div></details>`;
}

export function renderVisualReferences({ embedded = false, selectedReferences = null } = {}) {
  const action = '<div class="create-subpage-actions">' + (embedded ? "" : '<button class="secondary-button" data-return-create>返回创作</button>') + "</div>";
  const workspace = (viewState.feedback ? '<div class="reference-feedback">' + escapeHtml(viewState.feedback) + "</div>" : "") + '<section class="reference-workspace"><div class="reference-main"><section class="reference-collection">' + filters() + collection({ selectedReferences }) + "</section>" + detail({ embedded }) + "</div>" + importPanel({ embedded }) + groups({ embedded }) + "</section>";
  const selectedCount = selectedReferences?.size || 0;
  const heading = '<div class="drawing-section-heading"><div><span class="reference-kicker">视觉参考</span><h2>从资料库挑选本次参考</h2><p>先按角色或分组筛选，再在图片右下角勾选；点图片本身可以查看和整理资料。</p></div>' + (selectedReferences ? '<span class="drawing-reference-count">已选 ' + selectedCount + " 张</span>" : "") + "</div>";
  return embedded ? '<section class="drawing-references">' + heading + workspace + "</section>" : pageIntro("CREATE / VISUAL REFERENCES", "视觉参考库", "为可复用的视觉灵感建立清晰的资料库。", action) + workspace;
}
export function renderCreate() { return renderVisualReferences(); }

function rerender(context, result) {
  viewState.library = result || null;
  if (viewState.selectedId && !viewState.library?.assets.some((asset) => asset.id === viewState.selectedId)) viewState.selectedId = "";
  context.render();
  hydrateThumbnails(context);
}
export async function loadVisualReferences(context) {
  if (viewState.loading) return;
  viewState.loading = true;
  try { rerender(context, await context.api.visualReferences.snapshot()); } catch (error) { viewState.library = { status: "invalid", assets: [], sets: [], message: "读取资料库失败：" + (error?.message || error) }; context.render(); } finally { viewState.loading = false; }
}
async function hydrateThumbnails(context) {
  for (const asset of viewState.library?.assets || []) {
    if (viewState.thumbnails.has(asset.id)) continue;
    try {
      const image = await context.api.visualReferences.thumbnail(asset.id);
      viewState.thumbnails.set(asset.id, image);
      const tile = [...document.querySelectorAll("[data-select-reference]")].find((node) => node.dataset.selectReference === asset.id);
      if (tile) tile.querySelector(".reference-preview").innerHTML = '<img src="' + image + '" alt="">';
    } catch { viewState.thumbnails.set(asset.id, ""); }
  }
}
async function change(context, task, message) {
  try { await task(); viewState.feedback = message || ""; await loadVisualReferences(context); } catch (error) { viewState.feedback = error?.message || String(error); context.render(); }
}
export function bindCreateEvents(context) {
  document.querySelector("[data-return-create]")?.addEventListener("click", () => context.setCreatePage("overview"));
  document.querySelectorAll("[data-reference-role-filter]").forEach((button) => button.addEventListener("click", () => { viewState.role = button.dataset.referenceRoleFilter; context.render(); hydrateThumbnails(context); }));
  document.querySelector("[data-reference-set-filter]")?.addEventListener("change", (event) => { viewState.set = event.target.value; context.render(); hydrateThumbnails(context); });
  document.querySelectorAll("[data-select-reference]").forEach((button) => button.addEventListener("click", () => { viewState.selectedId = button.dataset.selectReference; context.render(); hydrateThumbnails(context); }));
  document.querySelector("[data-select-local-reference]")?.addEventListener("click", () => change(context, async () => { const role = document.querySelector("#referenceRole").value; const result = await context.api.visualReferences.selectImage(role); if (!result.canceled) viewState.pending = { ...result, role }; }, ""));
  document.querySelector("[data-cancel-reference-import]")?.addEventListener("click", () => { viewState.pending = null; context.render(); });
  document.querySelector("#referenceImportForm")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); change(context, async () => { await context.api.visualReferences.add({ selectionToken: viewState.pending.selectionToken, id: form.get("id"), role: form.get("role"), description: form.get("description"), preserve: textLines(form.get("preserve")), ignore: textLines(form.get("ignore")), sets: form.getAll("sets") }); viewState.pending = null; }, "资料已添加至视觉参考库。"); });
  document.querySelector("#referenceDetailForm")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); change(context, () => context.api.visualReferences.update({ id: viewState.selectedId, role: form.get("role"), description: form.get("description"), preserve: textLines(form.get("preserve")), ignore: textLines(form.get("ignore")), sets: form.getAll("sets") }), "资料已更新。"); });
  document.querySelector("#referenceSetForm")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); change(context, () => context.api.visualReferences.upsertSet({ id: form.get("id"), description: form.get("description") }), "分组已保存。"); });
  document.querySelectorAll("[data-remove-reference-set]").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.removeReferenceSet; if (window.confirm("移除此分组不会删除其中的资料。继续吗？")) change(context, () => context.api.visualReferences.removeSet(id), "分组已移除。"); }));
  document.querySelectorAll("[data-remove-reference]").forEach((button) => button.addEventListener("click", () => { const deleteFile = button.dataset.removeReference === "delete"; const question = deleteFile ? "将同时永久删除 Suzu Lives 数据目录中的图片副本。确定继续吗？" : "只从资料库移除，软件内图片副本会保留。确定继续吗？"; if (window.confirm(question)) change(context, () => context.api.visualReferences.remove({ id: viewState.selectedId, deleteFile, confirmed: true }), deleteFile ? "资料与软件内副本已移除。" : "资料已移除，软件内副本保留。"); }));
  hydrateThumbnails(context);
}
