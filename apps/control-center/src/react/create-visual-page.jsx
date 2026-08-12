import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Select, Status } from "suzu-design-system";

import { CreateStudioDialog } from "./create-studio-dialog.jsx";

const ROLES = Object.freeze({ identity: "人物", location: "地点", object: "物品", style: "风格" });
const ROLE_OPTIONS = Object.freeze(Object.entries(ROLES).map(([value, label]) => ({ label, value })));
const EMPTY_DRAWING_CONFIG = Object.freeze({ backend: "api", count: "1", seed: "", size: "1024x1024", workflow: "" });

function lines(value) {
  return String(value || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function statusTone(status) {
  return status === "ready" ? "success" : "warning";
}

function candidateLabel(candidate) {
  return candidate?.model || "候选图片";
}

function FormSelect({ defaultValue, name, options, placeholder = "请选择" }) {
  const [value, setValue] = useState(String(defaultValue ?? ""));
  return (
    <>
      <input name={name} type="hidden" value={value} />
      <Select className="create-select-react" fullWidth onChange={setValue} options={options} placeholder={placeholder} value={value} />
    </>
  );
}

function VisualRuns({ onOpenCandidate, runs = [] }) {
  return (
    <section className={`drawing-runs${runs.length ? "" : " drawing-runs-empty"}`}>
      <div className="drawing-section-head">
        <div>
          <span className="reference-kicker">本次创作</span>
          <h2>候选结果</h2>
          <p>把不同方向留在眼前，方便继续比较和挑选。</p>
        </div>
        <Status label={runs.length ? `${runs.length} 个批次` : "等待开始"} tone={runs.length ? "success" : "muted"} />
      </div>
      {runs.length ? (
        <div className="drawing-run-list">
          {runs.map((run) => (
            <article className="drawing-run" key={run.id}>
              <div className="drawing-run-copy">
                <strong title={run.prompt}>{run.prompt}</strong>
                <p>{[run.backend, run.status, run.createdAt].filter(Boolean).join(" · ")}</p>
              </div>
              <div className="drawing-candidates">
                {(run.candidates || []).map((candidate) => (
                  <button key={candidate.id} onClick={() => onOpenCandidate(run.id, candidate.id)} type="button">
                    <span>查看候选</span>
                    <small>{candidateLabel(candidate)}</small>
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : <div className="drawing-run-empty">还没有候选。写下提示词并生成后，本次结果会留在这里方便比较。</div>}
    </section>
  );
}

function ReferenceTile({ asset, chosen, onSelect, onToggle, preview, selected }) {
  return (
    <article className={`reference-card${chosen ? " reference-card--chosen" : ""}`}>
      <button aria-pressed={selected} className={`reference-tile${selected ? " selected" : ""}`} onClick={onSelect} type="button">
        <div className="reference-preview">
          {preview ? <img alt="" src={preview} /> : <span>缩略图加载中</span>}
        </div>
        <div className="reference-tile-copy">
          <span className="reference-role">{ROLES[asset.role] || asset.role}</span>
          <strong>{asset.description}</strong>
          <small>{asset.id}</small>
        </div>
      </button>
      <button
        aria-label={chosen ? `取消选择“${asset.description}”作为本次参考` : `选择“${asset.description}”作为本次参考`}
        aria-pressed={chosen}
        className={`reference-select-square${chosen ? " selected" : ""}`}
        onClick={onToggle}
        title={chosen ? "取消选择" : "选择作为本次参考"}
        type="button"
      >
        <span aria-hidden="true">{chosen ? "✓" : ""}</span>
      </button>
    </article>
  );
}

function ReferenceInspector({ asset, onRemove, onSave, sets = [] }) {
  if (!asset) return null;
  return (
    <details className="reference-detail reference-inspector" key={asset.id} open>
      <summary>
        <span><span className="reference-kicker">已选资料 · {ROLES[asset.role] || asset.role}</span><strong>{asset.description}</strong></span>
        <Status label="查看与编辑" tone="success" />
      </summary>
      <div className="reference-detail-body">
        <div className="reference-detail-head"><div><span className="reference-kicker">资料信息</span><h2>{asset.id}</h2></div></div>
        <form className="reference-form" onSubmit={onSave}>
          <label>角色
            <FormSelect defaultValue={asset.role} name="role" options={ROLE_OPTIONS} />
          </label>
          <label>资料 ID<input defaultValue={asset.id} disabled /></label>
          <label className="wide">描述<textarea defaultValue={asset.description} maxLength="2000" name="description" required /></label>
          <label>保留特征（一行一项）<textarea defaultValue={(asset.preserve || []).join("\n")} name="preserve" /></label>
          <label>忽略特征（一行一项）<textarea defaultValue={(asset.ignore || []).join("\n")} name="ignore" /></label>
          <fieldset className="wide"><legend>所属分组</legend>
            {sets.length ? sets.map((item) => (
              <label className="reference-set-check" key={item.id}>
                <input defaultChecked={(asset.sets || []).includes(item.id)} name="sets" type="checkbox" value={item.id} />
                <span>{item.description}</span><small>{item.id}</small>
              </label>
            )) : <p className="reference-form-hint">还没有分组；可先在下方创建分组。</p>}
          </fieldset>
          <div className="reference-form-actions wide"><button className="primary-button">保存修改</button></div>
        </form>
        <div className="reference-danger-zone">
          <strong>移除资料</strong>
          <p>“移除资料库”只删除登记；“删除软件内副本”会同时删除复制到 Suzu Lives 数据目录的图片。</p>
          <div><button className="secondary-button" onClick={() => onRemove(false)} type="button">从资料库移除</button><button className="danger-button" onClick={() => onRemove(true)} type="button">同时删除软件内副本</button></div>
        </div>
      </div>
    </details>
  );
}

function ReferenceImport({ empty, onCancel, onSelect, onSubmit, pending, role, setRole, sets = [] }) {
  return (
    <details className="reference-import-panel" defaultOpen={Boolean(pending) || empty} key={pending?.selectionToken || "reference-import"}>
      <summary><span><span className="reference-kicker">添加资料</span><strong>补充视觉参考</strong></span><span className="reference-detail-summary-note">从本机选择图片</span></summary>
      {pending ? (
        <div className="reference-import-panel-content reference-import-ready">
          <div><span className="reference-kicker">已选择</span><h2>{pending.fileName}</h2><p>补充资料后保存到视觉参考库，方便下一次创作继续使用。</p></div>
          <form className="reference-form" onSubmit={onSubmit}>
            <label>资料 ID<input defaultValue={pending.candidateId} maxLength="120" name="id" pattern="[a-z0-9.-]+" required /></label>
            <label>角色<FormSelect defaultValue={pending.role} name="role" options={ROLE_OPTIONS} /></label>
            <label className="wide">描述<textarea maxLength="2000" name="description" placeholder="写下这张图片实际呈现的内容。" required /></label>
            <label>保留特征（一行一项）<textarea name="preserve" placeholder="例如：脸型" /></label>
            <label>忽略特征（一行一项）<textarea name="ignore" placeholder="例如：背景" /></label>
            <fieldset className="wide"><legend>所属分组</legend>
              {sets.length ? sets.map((item) => <label className="reference-set-check" key={item.id}><input name="sets" type="checkbox" value={item.id} /><span>{item.description}</span><small>{item.id}</small></label>) : <p className="reference-form-hint">还没有分组；可在下方创建分组。</p>}
            </fieldset>
            <div className="reference-form-actions wide"><button className="secondary-button" onClick={onCancel} type="button">取消</button><button className="primary-button">导入到资料库</button></div>
          </form>
        </div>
      ) : (
        <div className="reference-import-panel-content">
          <div><span className="reference-kicker">本机图片</span><h2>添加一张参考资料</h2><p>从本机挑选图片，为它补充准确的描述、角色与分组。</p></div>
          <div className="reference-import-start"><label>角色<Select className="create-select-react" fullWidth onChange={setRole} options={ROLE_OPTIONS} value={role} /></label><button className="primary-button" onClick={onSelect} type="button">从本机选择图片</button></div>
        </div>
      )}
    </details>
  );
}

function ReferenceGroups({ onRemove, onSubmit, sets = [] }) {
  return (
    <details className="reference-groups">
      <summary><span><span className="reference-kicker">分组</span><strong>组织一组参考</strong></span><span className="reference-detail-summary-note">{sets.length} 个分组</span></summary>
      <div className="reference-groups-content">
        <div className="reference-group-list">
          {sets.length ? sets.map((item) => <article key={item.id}><strong>{item.description}</strong><small>{item.id} · {(item.assets || []).length} 项</small><button className="quiet-link" onClick={() => onRemove(item.id)} type="button">移除分组</button></article>) : <p className="reference-form-hint">尚无分组。</p>}
        </div>
        <form className="reference-set-form" onSubmit={onSubmit}><input maxLength="120" name="id" pattern="[a-z0-9.-]+" placeholder="分组 ID，例如 character-main" required /><input maxLength="2000" name="description" placeholder="分组说明" required /><button className="secondary-button">创建 / 更新分组</button></form>
      </div>
    </details>
  );
}

export function CreateVisualPage({ actions = {}, api }) {
  const [drawing, setDrawing] = useState(null);
  const [references, setReferences] = useState(null);
  const [thumbnails, setThumbnails] = useState({});
  const [selectedReferences, setSelectedReferences] = useState(() => new Set());
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [referenceRole, setReferenceRole] = useState("all");
  const [referenceSet, setReferenceSet] = useState("all");
  const [importRole, setImportRole] = useState("identity");
  const [pendingImport, setPendingImport] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [config, setConfig] = useState(EMPTY_DRAWING_CONFIG);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const reloadReferences = useCallback(async () => {
    const nextReferences = await api.visualReferences.snapshot();
    setReferences(nextReferences);
    const knownIds = new Set((nextReferences.assets || []).map((asset) => asset.id));
    setSelectedReferences((previous) => new Set([...previous].filter((id) => knownIds.has(id))));
    setSelectedAssetId((previous) => knownIds.has(previous) ? previous : "");
    return nextReferences;
  }, [api]);

  const reload = useCallback(async () => {
    try {
      const [nextDrawing] = await Promise.all([api.imageWorkbench.snapshot(), reloadReferences()]);
      setDrawing(nextDrawing);
    } catch (error) {
      setFeedback(error?.message || String(error));
    }
  }, [api, reloadReferences]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    let cancelled = false;
    const missing = (references?.assets || []).filter((asset) => !(asset.id in thumbnails));
    if (!missing.length) return () => { cancelled = true; };
    void Promise.all(missing.map(async (asset) => {
      try {
        const image = await api.visualReferences.thumbnail(asset.id);
        if (!cancelled) setThumbnails((previous) => ({ ...previous, [asset.id]: image || "" }));
      } catch {
        if (!cancelled) setThumbnails((previous) => ({ ...previous, [asset.id]: "" }));
      }
    }));
    return () => { cancelled = true; };
  }, [api, references, thumbnails]);

  const assets = useMemo(() => (references?.assets || []).filter((asset) => (
    (referenceRole === "all" || asset.role === referenceRole)
    && (referenceSet === "all" || (asset.sets || []).includes(referenceSet))
  )), [referenceRole, referenceSet, references]);
  const selectedAsset = useMemo(() => (references?.assets || []).find((asset) => asset.id === selectedAssetId) || null, [references, selectedAssetId]);
  const workflows = drawing?.comfyui?.workflows || [];
  const ready = drawing?.status === "ready";

  const withReferenceChange = useCallback(async (task, success) => {
    try {
      await task();
      await reloadReferences();
      setFeedback(success);
    } catch (error) {
      setFeedback(error?.message || String(error));
    }
  }, [reloadReferences]);

  const generate = async (event) => {
    event.preventDefault();
    const prompt = String(new FormData(event.currentTarget).get("prompt") || "").trim();
    if (!prompt || creating) return;
    setCreating(true);
    try {
      const rawSeed = String(config.seed || "").trim();
      setDrawing(await api.imageWorkbench.generate({
        backend: config.backend,
        count: Number(config.count),
        prompt,
        referenceIds: [...selectedReferences],
        seed: rawSeed ? Number(rawSeed) : null,
        size: config.size,
        workflow: config.workflow,
      }));
      setFeedback("候选已保存，方便继续比较和挑选。");
    } catch (error) {
      setFeedback(error?.message || String(error));
    } finally {
      setCreating(false);
    }
  };

  const openCandidate = async (runId, candidateId) => {
    try {
      const image = await api.imageWorkbench.thumbnail(runId, candidateId);
      window.open(image, "_blank", "noopener,noreferrer");
    } catch (error) {
      setFeedback(error?.message || String(error));
    }
  };

  const selectLocalReference = async () => {
    try {
      const selection = await api.visualReferences.selectImage(importRole);
      if (!selection?.canceled) setPendingImport({ ...selection, role: importRole });
    } catch (error) {
      setFeedback(error?.message || String(error));
    }
  };

  const importReference = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void withReferenceChange(async () => {
      await api.visualReferences.add({
        description: form.get("description"),
        id: form.get("id"),
        ignore: lines(form.get("ignore")),
        preserve: lines(form.get("preserve")),
        role: form.get("role"),
        selectionToken: pendingImport?.selectionToken,
        sets: form.getAll("sets"),
      });
      setPendingImport(null);
    }, "资料已添加至视觉参考库。");
  };

  const saveReference = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void withReferenceChange(() => api.visualReferences.update({
      description: form.get("description"),
      id: selectedAssetId,
      ignore: lines(form.get("ignore")),
      preserve: lines(form.get("preserve")),
      role: form.get("role"),
      sets: form.getAll("sets"),
    }), "资料已更新。");
  };

  const removeReference = (deleteFile) => {
    const question = deleteFile ? "将同时永久删除 Suzu Lives 数据目录中的图片副本。确定继续吗？" : "只从资料库移除，软件内图片副本会保留。确定继续吗？";
    if (!window.confirm(question)) return;
    void withReferenceChange(() => api.visualReferences.remove({ id: selectedAssetId, deleteFile, confirmed: true }), deleteFile ? "资料与软件内副本已移除。" : "资料已移除，软件内副本保留。");
  };

  const saveGroup = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void withReferenceChange(() => api.visualReferences.upsertSet({ id: form.get("id"), description: form.get("description") }), "分组已保存。");
    event.currentTarget.reset();
  };

  const removeGroup = (id) => {
    if (!window.confirm("移除此分组不会删除其中的资料。继续吗？")) return;
    void withReferenceChange(() => api.visualReferences.removeSet(id), "分组已移除。");
  };

  return (
    <>
      <PageHeader
        action={<div className="create-subpage-actions"><button className="secondary-button" onClick={actions.returnToOverview} type="button">返回创作</button><button aria-label="绘画设置" className="create-settings-button" onClick={() => setSettingsOpen(true)} title="绘画设置" type="button"><span aria-hidden="true">⚙</span></button></div>}
        className="create-studio-page-header"
        eyebrow="CREATE / VISUAL"
        subtitle="让提示词、视觉参考与候选结果保持在同一条创作流里。"
        title="视觉工作台"
      />
      {feedback ? <div className="reference-feedback" role="status">{feedback}</div> : null}
      <section className="drawing-workbench visual-workbench">
        <section className="drawing-compose-panel">
          <div className="drawing-head"><div><span className="reference-kicker">开始创作</span><h2>从灵感到候选</h2><p>{ready ? "写下画面方向，挑选参考，再把可比较的候选留在同一处。" : "选择有效项目后，即可开始整理提示词、参考与候选。"}</p></div><Status label={ready ? "可以开始" : "需要项目"} tone={statusTone(drawing?.status)} /></div>
          <form className="voice-form drawing-generate-form" onSubmit={generate}>
            <label className="wide drawing-prompt-field">绘画提示词<textarea disabled={creating} maxLength="4000" name="prompt" placeholder="描述你想看见的画面、氛围与主体。" required /><small>最多 4000 字</small></label>
            <div className="drawing-reference-summary"><div><span className="reference-kicker">本次参考</span><strong>{selectedReferences.size ? `已选 ${selectedReferences.size} 张参考图` : "还没有选择参考图"}</strong><p>在下方视觉参考库按分类浏览图片，在图片右下角勾选。</p></div>{selectedReferences.size ? <button className="quiet-link" onClick={() => setSelectedReferences(new Set())} type="button">清空选择</button> : null}</div>
            <div className="voice-form-actions wide drawing-create-actions"><span className="drawing-engine-state">{workflows.some((item) => item.enabled) ? "可使用本机出图" : "可使用已保存的图像服务"}</span><button className="primary-button" disabled={!ready || creating}>{creating ? "正在生成…" : "生成图片"}</button></div>
          </form>
        </section>
        <VisualRuns onOpenCandidate={openCandidate} runs={drawing?.runs || []} />
      </section>
      <section className="drawing-references">
        <div className="drawing-section-heading"><div><span className="reference-kicker">视觉参考</span><h2>从资料库挑选本次参考</h2><p>先按角色或分组筛选，再在图片右下角勾选；点图片本身可以查看和整理资料。</p></div><span className="drawing-reference-count">已选 {selectedReferences.size} 张</span></div>
        <section className="reference-workspace">
          <div className="reference-main">
            <section className="reference-collection">
              <div className="reference-filters"><div className="filter-row"><span>角色</span>{[["all", "全部"], ...Object.entries(ROLES)].map(([id, label]) => <button className={`filter-button${referenceRole === id ? " active" : ""}`} key={id} onClick={() => setReferenceRole(id)} type="button">{label}</button>)}</div><label className="reference-group-filter">分组<Select className="create-select-react reference-group-filter__select" onChange={setReferenceSet} options={[{ label: "全部分组", value: "all" }, ...(references?.sets || []).map((item) => ({ label: item.description, value: item.id }))]} value={referenceSet} /></label></div>
              {references?.status === "invalid" ? <section className="reference-empty reference-error"><h2>资料库暂时无法打开</h2><p>请稍后重试，或检查资料库设置。</p></section> : !references ? <section className="reference-empty"><h2>正在读取视觉参考库</h2><p>请稍候，资料会显示在这里。</p></section> : assets.length ? <div className="reference-grid">{assets.map((asset) => <ReferenceTile asset={asset} chosen={selectedReferences.has(asset.id)} key={asset.id} onSelect={() => setSelectedAssetId(asset.id)} onToggle={() => setSelectedReferences((previous) => { const next = new Set(previous); if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id); return next; })} preview={thumbnails[asset.id]} selected={selectedAssetId === asset.id} />)}</div> : <section className="reference-empty"><h2>{references.assets?.length ? "没有匹配的参考资料" : "资料库还是空的"}</h2><p>{references.assets?.length ? "调整角色或分组筛选，或从本机添加图片。" : "从本机添加第一张图片，建立这次创作的起点。"}</p></section>}
            </section>
            <ReferenceInspector asset={selectedAsset} onRemove={removeReference} onSave={saveReference} sets={references?.sets || []} />
          </div>
          <ReferenceImport empty={!references?.assets?.length} onCancel={() => setPendingImport(null)} onSelect={selectLocalReference} onSubmit={importReference} pending={pendingImport} role={importRole} setRole={setImportRole} sets={references?.sets || []} />
          <ReferenceGroups onRemove={removeGroup} onSubmit={saveGroup} sets={references?.sets || []} />
        </section>
      </section>
      <CreateStudioDialog ariaLabel="绘画设置" onClose={() => setSettingsOpen(false)} open={settingsOpen}>
        <header className="create-settings-dialog__header"><div><span className="reference-kicker">绘画设置</span><h2>尺寸、出图方式与本机工作流</h2></div><button aria-label="关闭绘画设置" className="create-settings-close suzu-close-button" onClick={() => setSettingsOpen(false)} type="button"><span aria-hidden="true">×</span></button></header>
        <div className="drawing-settings-body">
          <label>出图方式<Select className="create-select-react" fullWidth onChange={(backend) => setConfig((previous) => ({ ...previous, backend }))} options={[{ label: "云端图像 API", value: "api" }, { label: "本机 ComfyUI", value: "comfyui" }]} value={config.backend} /></label>
          <label>候选数<input max="20" min="1" onChange={(event) => setConfig((previous) => ({ ...previous, count: event.target.value }))} type="number" value={config.count} /></label>
          <label>尺寸<input onChange={(event) => setConfig((previous) => ({ ...previous, size: event.target.value }))} pattern="\d{2,5}x\d{2,5}" value={config.size} /></label>
          <label>Seed（可选）<input max="9007199254740991" min="0" onChange={(event) => setConfig((previous) => ({ ...previous, seed: event.target.value }))} placeholder="留空则随机生成" type="number" value={config.seed} /></label>
          <label className="drawing-workflow-field">使用哪个 ComfyUI 工作流<Select className="create-select-react" fullWidth onChange={(workflow) => setConfig((previous) => ({ ...previous, workflow }))} options={workflows.filter((item) => item.enabled).map((item) => ({ label: item.description || item.id, value: item.id }))} placeholder="选择可用工作流" value={config.workflow} /></label>
          <p className="drawing-settings-note">本机可用的 ComfyUI 工作流会显示在这里；云端图像 API 可在管理 → API 中调整。</p>
        </div>
      </CreateStudioDialog>
    </>
  );
}
