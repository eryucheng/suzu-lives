import { useEffect, useState } from "react";
import { Avatar, Banner, Button, Dialog, Empty, GlassPanel, Input, PageHeader, Roster, Select, Tabs, Textarea } from "suzu-design-system";

import { getIdentity } from "../core/identity.mjs";
import { PageScaffold } from "./page-scaffold.jsx";
import "./relationship-settings-page.css";

function clean(value) {
  return String(value ?? "").trim();
}

function selectedFile(files, selectedPath) {
  return files.find((file) => file.path === selectedPath) || files[0] || null;
}

function fileLabel(file) {
  const path = clean(file?.path).toLowerCase();
  if (path === "suzu.md") return "总设定";
  if (path === "persona.md") return "人格与相处方式";
  if (path === "user.md") return "关于我";
  return clean(file?.path) || "未命名资料";
}

function contactName(contact) {
  return clean(contact?.name) || "未命名联系人";
}

function contactAvatarSource(contact, settings) {
  const identity = getIdentity(settings);
  const agentId = clean(contact?.agentId);
  return clean(identity?.agents?.[agentId]?.avatarDataUrl || identity?.defaultAgent?.avatarDataUrl);
}

const APPROVAL_MODE_OPTIONS = [
  { label: "全权限（不审批）", value: "danger-full-access" },
  { label: "工作目录可写", value: "workspace-write" },
  { label: "只读", value: "read-only" },
];

function approvalModeDescription(value) {
  switch (value) {
    case "workspace-write":
      return "可在当前联系人的工作目录和允许的临时目录写入；需要更大范围时询问。";
    case "read-only":
      return "默认不能修改文件；需要提升权限时再询问。";
    default:
      return "可访问并修改任意位置，不弹出审批。";
  }
}

function WorkspaceEmpty({ description, title }) {
  return <Empty className="relationship-settings-empty" description={description} title={title} />;
}

function ContactRail({ activeContact, contacts, disabled, onSelect, settings }) {
  const activeId = clean(activeContact?.id);
  return (
    <GlassPanel as="aside" className="relationship-settings-contact-rail" intensity="soft">
      <div className="relationship-settings-contact-rail__heading">
        <div><span>CONTACTS</span><strong>联系人</strong></div>
        <b>{contacts.length}</b>
      </div>
      <div className="relationship-settings-contact-list" aria-label="选择联系人">
        {contacts.map((contact) => {
          const name = contactName(contact);
          const selected = clean(contact.id) === activeId;
          return (
            <Roster
              avatar={<Avatar name={name} size="md" src={contactAvatarSource(contact, settings)} />}
              className="relationship-settings-contact"
              key={contact.id}
              name={name}
              onClick={disabled ? undefined : () => onSelect(contact.id)}
              selected={selected}
              subtitle={selected ? "当前联系人" : "切换到此联系人"}
            />
          );
        })}
      </div>
    </GlassPanel>
  );
}

function NewFileDialog({ onClose, onCreate, pending }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    if (!clean(path)) {
      setError("请填写资料文件路径。 ");
      return;
    }
    setError("");
    try {
      await onCreate({ content, path });
    } catch (createError) {
      setError(clean(createError?.message) || "无法添加相处资料。 ");
    }
  };
  const footer = (
    <div className="relationship-settings-dialog-actions">
      <Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button>
      <Button disabled={pending} form="relationshipNewFileForm" type="submit">{pending ? "正在添加…" : "添加资料"}</Button>
    </div>
  );
  return (
    <Dialog footer={footer} onClose={pending ? () => {} : onClose} open title="添加相处资料">
      <form className="relationship-settings-create-form" id="relationshipNewFileForm" onSubmit={submit}>
        <label>
          <span>文件路径</span>
          <Input autoFocus maxLength="240" onChange={(event) => setPath(event.target.value)} placeholder="例如 notes/bond.md" value={path} />
        </label>
        <label>
          <span>初始内容 <small>可选</small></span>
          <Textarea maxLength="1000000" onChange={(event) => setContent(event.target.value)} placeholder="写下这份资料的初始内容" rows={7} value={content} />
        </label>
        {error ? <p className="relationship-settings-form-error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function RelationshipEditor({ actions, activeContact, current, files, onSelectFile, settings }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  useEffect(() => {
    setDraft(current?.content || "");
    setError("");
  }, [current?.content, current?.path]);

  const save = async () => {
    if (!current || current.readOnly || pending) return;
    setPending("save");
    setError("");
    try {
      await actions.saveFile?.({ content: draft, path: current.path });
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存相处资料。 ");
    } finally {
      setPending("");
    }
  };

  const create = async (value) => {
    if (pending) return;
    setPending("create");
    try {
      await actions.createFile?.(value);
      setCreateOpen(false);
    } finally {
      setPending("");
    }
  };

  const savePermissionMode = async (permissionMode) => {
    if (pending || !clean(activeContact?.id) || permissionMode === approvalMode) return;
    setPending("permission-mode");
    setError("");
    try {
      await actions.savePermissionMode?.({ id: activeContact.id, permissionMode });
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法更新联系人审批模式。 ");
    } finally {
      setPending("");
    }
  };

  const name = contactName(activeContact);
  const readOnly = current?.readOnly === true;
  const approvalMode = clean(activeContact?.permissionMode) || "danger-full-access";
  const tabItems = files.map((file) => ({ label: fileLabel(file), value: file.path }));
  return (
    <>
      <header className="relationship-settings-editor-header">
        <div className="relationship-settings-editor-contact">
          <Avatar name={name} size="lg" src={contactAvatarSource(activeContact, settings)} />
          <div><span>正在整理</span><h2>{name}</h2></div>
        </div>
        <Tabs active={current?.path || ""} className="relationship-settings-file-tabs" items={tabItems} onChange={onSelectFile} size="lg" />
        <Button className="relationship-settings-new-file-button" disabled={Boolean(pending)} onClick={() => setCreateOpen(true)} variant="secondary">添加资料</Button>
      </header>

      <section className="relationship-settings-approval-mode" aria-label="联系人审批模式">
        <div>
          <span>审批模式</span>
          <p>{approvalModeDescription(approvalMode)}</p>
        </div>
        <Select
          ariaLabel="审批模式"
          disabled={Boolean(pending)}
          fullWidth
          onChange={savePermissionMode}
          options={APPROVAL_MODE_OPTIONS}
          value={approvalMode}
        />
      </section>

      {error ? <Banner className="relationship-settings-editor-error" tone="danger">{error}</Banner> : null}
      {readOnly ? <Banner className="relationship-settings-editor-error" tone="warning">{current.message || "这是从旧版本保留下来的资料，仅供查看；新的相处设定请写入 SUZU.md。"}</Banner> : null}
      {current ? (
        <section className="relationship-settings-editor" aria-label={`${fileLabel(current)} 编辑器`}>
          <div className="relationship-settings-editor__toolbar">
            <div>
              <span>当前文件</span>
              <strong>{fileLabel(current)}</strong>
              <code>{current.path}</code>
            </div>
            <Button className="relationship-settings-save-button" disabled={readOnly || Boolean(pending)} onClick={save}>{readOnly ? "只读" : pending === "save" ? "正在保存…" : "保存"}</Button>
          </div>
          <Textarea
            aria-label={`${current.path} 内容`}
            className="relationship-settings-editor__textarea"
            disabled={readOnly || Boolean(pending)}
            maxLength="1000000"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="写下这份资料的内容"
            value={draft}
          />
        </section>
      ) : <WorkspaceEmpty description="当前联系人还没有可编辑的相处资料。" title="没有可编辑的资料" />}

      {createOpen ? <NewFileDialog onClose={() => setCreateOpen(false)} onCreate={create} pending={pending === "create"} /> : null}
    </>
  );
}

export function RelationshipSettingsPage({ actions = {}, snapshot = {} }) {
  const contactsSnapshot = snapshot.contacts;
  const contactsReady = Boolean(contactsSnapshot);
  const contacts = Array.isArray(contactsSnapshot?.contacts) ? contactsSnapshot.contacts : [];
  const activeContact = contactsSnapshot?.activeContact || null;
  const filesSnapshot = snapshot.files;
  const files = Array.isArray(filesSnapshot?.files) ? filesSnapshot.files : [];
  const current = selectedFile(files, snapshot.selectedPath);
  const canEdit = Boolean(activeContact) && filesSnapshot?.status !== "needs-project";
  const [contactError, setContactError] = useState("");
  const [selectingContact, setSelectingContact] = useState(false);
  const selectContact = async (id) => {
    if (selectingContact || clean(id) === clean(activeContact?.id)) return;
    setSelectingContact(true);
    setContactError("");
    try {
      await actions.selectContact?.(id);
    } catch (selectError) {
      setContactError(clean(selectError?.message) || "无法切换联系人。 ");
    } finally {
      setSelectingContact(false);
    }
  };
  const selectFile = (path) => {
    if (!clean(path) || path === current?.path) return;
    actions.selectFile?.(path);
  };

  return (
    <PageScaffold
      canvasClassName="page-canvas--fill"
      className="relationship-settings-react-page"
      header={(
        <PageHeader
          action={<Button className="relationship-settings-return-button" onClick={actions.returnToOverview} variant="secondary">返回关系</Button>}
          eyebrow="RELATIONSHIP SETUP"
          subtitle="为不同联系人整理相处方式、背景与长期规则。"
          title="相处设定"
        />
      )}
    >
      <div className="relationship-settings-page-body">

        {snapshot.error || contactError ? <Banner className="relationship-settings-page-error" tone="danger">{contactError || snapshot.error}</Banner> : null}
        {!contactsReady ? (
          <GlassPanel as="section" className="relationship-settings-loading" intensity="soft"><WorkspaceEmpty description="正在读取联系人和相处资料。" title="正在加载相处设定" /></GlassPanel>
        ) : !contacts.length ? (
          <GlassPanel as="section" className="relationship-settings-loading" intensity="soft"><WorkspaceEmpty description="先返回关系页创建一位联系人，再为对方整理相处资料。" title="还没有联系人" /></GlassPanel>
        ) : (
          <section className="relationship-settings-workspace" aria-label="相处资料工作台">
            <ContactRail activeContact={activeContact} contacts={contacts} disabled={selectingContact} onSelect={selectContact} settings={snapshot.settings} />
            <GlassPanel as="section" className="relationship-settings-workspace__main" intensity="soft">
              {!activeContact ? <WorkspaceEmpty description="从联系人列表选择一位联系人，开始整理相处资料。" title="选择联系人" />
                : filesSnapshot?.status === "needs-project" ? <WorkspaceEmpty description="请先为当前联系人选择 Suzu 联系人工作区。" title="尚未设置联系人工作区" />
                  : !canEdit || !filesSnapshot ? <WorkspaceEmpty description="正在读取当前联系人的相处资料。" title="正在加载资料" />
                    : <RelationshipEditor actions={actions} activeContact={activeContact} current={current} files={files} onSelectFile={selectFile} settings={snapshot.settings} />}
            </GlassPanel>
          </section>
        )}
      </div>
    </PageScaffold>
  );
}
