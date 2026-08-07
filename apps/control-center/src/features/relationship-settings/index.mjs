import { escapeHtml } from "../../core/formatters.mjs";
import { getIdentity, profileInitial } from "../../core/identity.mjs";
import { pageIntro } from "../../components/panel.mjs";

function selectedFile(snapshot, selectedPath) {
  return snapshot?.files?.find((file) => file.path === selectedPath) || snapshot?.files?.[0] || null;
}

function clean(value) {
  return String(value ?? "").trim();
}

function relationshipFileLabel(file) {
  const path = clean(file?.path);
  if (path.toLowerCase() === "claude.md") return "总设定";
  if (path.toLowerCase() === "persona.md") return "人格与相处方式";
  if (path.toLowerCase() === "user.md") return "关于我";
  return path || "未命名资料";
}

function relationshipFileMeta(file) {
  const path = clean(file?.path);
  if (path.toLowerCase() === "claude.md") return "整体相处规则";
  if (path.toLowerCase() === "persona.md") return "性格与相处方式";
  if (path.toLowerCase() === "user.md") return "关于你的资料";
  return "补充资料";
}

function relationshipContacts(context) {
  const snapshot = context.state.relationshipContacts;
  return {
    ready: Boolean(snapshot),
    contacts: Array.isArray(snapshot?.contacts) ? snapshot.contacts : [],
    activeContact: snapshot?.activeContact || null,
  };
}

function contactProfile(contact, settings) {
  const identity = getIdentity(settings);
  const name = clean(contact?.name) || "未命名联系人";
  return identity?.agents?.[clean(contact?.agentId)] || identity?.defaultAgent || { displayName: name, avatarDataUrl: "" };
}

function contactAvatar(contact, settings) {
  const profile = contactProfile(contact, settings);
  const name = clean(contact?.name) || "未命名联系人";
  return profile.avatarDataUrl
    ? `<img src="${escapeHtml(profile.avatarDataUrl)}" alt="">`
    : `<span>${escapeHtml(profileInitial({ displayName: name }, name))}</span>`;
}

function renderContactRail(context, contacts, activeContact) {
  const activeId = clean(activeContact?.id);
  return `<aside class="relationship-contact-rail" aria-label="联系人">
    <div class="relationship-contact-rail__heading"><strong>联系人</strong><span>${contacts.length} 位</span></div>
    <nav class="relationship-contact-rail__list" aria-label="选择联系人">
      ${contacts.map((contact) => {
    const id = clean(contact.id);
    const name = clean(contact.name) || "未命名联系人";
    const selected = id === activeId;
    return `<button type="button" class="relationship-contact-item${selected ? " active" : ""}" data-relationship-contact="${escapeHtml(id)}" ${selected ? 'aria-current="page"' : ""}>
          <span class="relationship-contact-item__avatar">${contactAvatar(contact, context.state.settings)}</span>
          <span class="relationship-contact-item__copy"><strong>${escapeHtml(name)}</strong><small>${selected ? "正在编辑" : "点击编辑"}</small></span>
        </button>`;
  }).join("")}
    </nav>
  </aside>`;
}

export function renderRelationshipSettings(context) {
  const snapshot = context.state.relationshipFiles;
  const current = selectedFile(snapshot, context.state.relationshipFilePath);
  const error = context.state.relationshipFilesError;
  const needsProject = snapshot?.status === "needs-project";
  const fileList = snapshot?.files || [];
  const { ready: contactsReady, contacts, activeContact } = relationshipContacts(context);
  const canEdit = Boolean(activeContact) && !needsProject;
  return `${pageIntro("RELATIONSHIPS / SETUP", "相处设定", "为不同联系人分别整理相处方式、背景与长期规则。", '<button class="secondary-button" data-return-relationships>返回关系</button>')}
    <section class="relationship-settings-view">
      ${error ? `<div class="relationship-settings-error" role="alert">${escapeHtml(error)}</div>` : ""}
      ${!contactsReady ? `<div class="relationship-settings-empty">正在读取联系人…</div>` : !contacts.length ? `<div class="relationship-settings-empty">还没有联系人。先返回关系页创建一位联系人。</div>` : `
        <div class="relationship-settings-workspace">
          ${renderContactRail(context, contacts, activeContact)}
          <section class="relationship-profile-workspace" aria-label="当前联系人相处设定">
            ${!canEdit ? `<div class="relationship-settings-empty">从左侧选择一位联系人，开始整理相处资料。</div>` : `
              <header class="relationship-profile-header">
                <span class="relationship-profile-header__avatar">${contactAvatar(activeContact, context.state.settings)}</span>
                <div><span>正在编辑</span><h2>${escapeHtml(clean(activeContact.name) || "未命名联系人")}</h2></div>
              </header>
              <div class="relationship-file-toolbar">
                <nav class="relationship-file-tabs" aria-label="相处资料">
                  ${fileList.map((file) => `<button type="button" class="relationship-file-tab${current?.path === file.path ? " active" : ""}" data-relationship-file="${escapeHtml(file.path)}" ${current?.path === file.path ? 'aria-current="page"' : ""} title="${escapeHtml(relationshipFileMeta(file))}">${escapeHtml(relationshipFileLabel(file))}${file.exists ? "" : " · 待填写"}</button>`).join("")}
                </nav>
                <details class="relationship-create">
                  <summary>添加资料</summary>
                  <form id="relationshipCreateForm" class="relationship-create-form">
                    <label><span>文件名</span><input id="relationshipNewFilePath" maxlength="240" placeholder="例如 notes/bond.md" aria-label="新资料文件名"></label>
                    <label><span>内容</span><textarea id="relationshipNewFileContent" maxlength="1000000" placeholder="可选的初始内容" aria-label="新资料内容"></textarea></label>
                    <button class="secondary-button">添加</button>
                  </form>
                </details>
              </div>
              <div class="relationship-editor">
                ${current ? `<div class="relationship-editor-heading"><div><span>相处资料</span><strong>${escapeHtml(relationshipFileLabel(current))}</strong></div><button type="button" class="primary-button" data-save-relationship-file>保存</button></div>
                  <textarea id="relationshipFileContent" maxlength="1000000" aria-label="${escapeHtml(current.path)} 内容" placeholder="写下这份资料的内容">${escapeHtml(current.content || "")}</textarea>` : `<div class="relationship-settings-empty">没有可编辑的相处资料。</div>`}
              </div>`}
          </section>
        </div>`}
    </section>`;
}

function applyRelationshipContacts(context, snapshot) {
  context.state.relationshipContacts = {
    contacts: Array.isArray(snapshot?.contacts) ? snapshot.contacts : [],
    activeContact: snapshot?.activeContact || null,
  };
}

export async function loadRelationshipFiles(context, { contactSnapshot = null } = {}) {
  try {
    applyRelationshipContacts(context, contactSnapshot || await context.api.conversation.snapshot());
    const snapshot = await context.api.relationshipFiles.snapshot();
    context.state.relationshipFiles = snapshot;
    const current = selectedFile(snapshot, context.state.relationshipFilePath);
    context.state.relationshipFilePath = current?.path || "";
    context.state.relationshipFilesError = "";
  } catch (error) {
    context.state.relationshipFiles = null;
    context.state.relationshipFilesError = `读取相处设定失败：${error?.message || error}`;
  }
  context.render();
}

export async function selectRelationshipContact(context, id) {
  const snapshot = await context.api.conversation.selectContact({ id });
  applyRelationshipContacts(context, snapshot);
  context.state.relationshipFilePath = "";
  if (context.api.settings?.get) context.state.settings = await context.api.settings.get().catch(() => context.state.settings);
  await loadRelationshipFiles(context, { contactSnapshot: snapshot });
}

export function bindRelationshipSettingsEvents(context) {
  document.querySelectorAll("[data-relationship-contact]").forEach((button) => button.addEventListener("click", async () => {
    const id = clean(button.dataset.relationshipContact);
    if (!id || !context.api.conversation?.selectContact) return;
    document.querySelectorAll("[data-relationship-contact]").forEach((item) => { item.disabled = true; });
    try {
      await selectRelationshipContact(context, id);
    } catch (error) {
      context.state.relationshipFilesError = `切换联系人失败：${error?.message || error}`;
      context.render();
    }
  }));
  document.querySelectorAll("[data-relationship-file]").forEach((button) => button.addEventListener("click", () => {
    context.state.relationshipFilePath = button.dataset.relationshipFile || "";
    context.state.relationshipFilesError = "";
    context.render();
  }));
  document.querySelector("[data-save-relationship-file]")?.addEventListener("click", async () => {
    const file = selectedFile(context.state.relationshipFiles, context.state.relationshipFilePath);
    const content = document.querySelector("#relationshipFileContent")?.value ?? "";
    if (!file) return;
    try {
      context.state.relationshipFiles = await context.api.relationshipFiles.save({ path: file.path, content });
      context.state.relationshipFilePath = file.path;
      context.state.relationshipFilesError = "";
      context.setNotice("已保存相处资料。 ");
    } catch (error) {
      context.state.relationshipFilesError = `保存失败：${error?.message || error}`;
    }
    context.render();
  });
  document.querySelector("#relationshipCreateForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const path = document.querySelector("#relationshipNewFilePath")?.value ?? "";
    const content = document.querySelector("#relationshipNewFileContent")?.value ?? "";
    try {
      const snapshot = await context.api.relationshipFiles.create({ path, content });
      context.state.relationshipFiles = snapshot;
      context.state.relationshipFilePath = path.trim().replaceAll("\\", "/");
      context.state.relationshipFilesError = "";
      context.setNotice("已添加相处资料。 ");
    } catch (error) {
      context.state.relationshipFilesError = `创建失败：${error?.message || error}`;
    }
    context.render();
  });
}
