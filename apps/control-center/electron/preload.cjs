const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("suzuConsole", {
  windowChrome: {
    applyTheme: (theme) => ipcRenderer.invoke("window-chrome:apply-theme", theme),
    customControls: process.platform === "win32",
    state: () => ipcRenderer.invoke("window-chrome:state"),
    control: (action) => ipcRenderer.invoke("window-chrome:control", action),
    onState: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("window-chrome:state", listener);
      return () => ipcRenderer.removeListener("window-chrome:state", listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    releaseAnnouncementStatus: () => ipcRenderer.invoke("settings:release-announcement-status"),
    acknowledgeReleaseAnnouncement: () => ipcRenderer.invoke("settings:acknowledge-release-announcement"),
    appUpdateStatus: () => ipcRenderer.invoke("settings:app-update-status"),
    checkForUpdate: () => ipcRenderer.invoke("settings:check-for-update"),
    downloadUpdate: () => ipcRenderer.invoke("settings:download-update"),
    installUpdate: () => ipcRenderer.invoke("settings:install-update"),
    systemStatus: () => ipcRenderer.invoke("settings:system-status"),
    changeDataLocation: () => ipcRenderer.invoke("settings:change-data-location"),
    removePreviousDataCopy: () => ipcRenderer.invoke("settings:remove-previous-data-copy"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    showItemInFolder: (targetPath) => ipcRenderer.invoke("shell:show-item", targetPath),
  },
  ledger: {
    scan: () => ipcRenderer.invoke("ledger:scan"),
  },
  todayCalendar: {
    snapshot: (value) => ipcRenderer.invoke("today-calendar:snapshot", value),
    saveEvent: (value) => ipcRenderer.invoke("today-calendar:save-event", value),
    removeEvent: (value) => ipcRenderer.invoke("today-calendar:remove-event", value),
  },
  capabilities: {
    snapshot: () => ipcRenderer.invoke("capabilities:snapshot"),
    companionTargets: () => ipcRenderer.invoke("capabilities:companion-targets"),
    register: (id) => ipcRenderer.invoke("capabilities:register", id),
    setActive: (id, enabled) => ipcRenderer.invoke("capabilities:set-active", { id, enabled }),
    saveSettings: (id, value) => ipcRenderer.invoke("capabilities:save-settings", { id, value }),
  },
  externalCapabilities: {
    snapshot: () => ipcRenderer.invoke("external-capabilities:snapshot"),
    importManifest: () => ipcRenderer.invoke("external-capabilities:import"),
    setEnabled: (id, enabled) => ipcRenderer.invoke("external-capabilities:set-enabled", { id, enabled }),
    remove: (id, confirmed = false) => ipcRenderer.invoke("external-capabilities:remove", { id, confirmed }),
  },
  agentRuntime: {
    snapshot: () => ipcRenderer.invoke("agent-runtime:snapshot"),
    saveModelConfiguration: (value) => ipcRenderer.invoke("agent-runtime:save-model-configuration", value),
    fetchModels: (value = {}) => ipcRenderer.invoke("agent-runtime:fetch-models", value),
  },
  conversation: {
    snapshot: () => ipcRenderer.invoke("conversation:snapshot"),
    search: (query) => ipcRenderer.invoke("conversation:search", query),
    contextTrace: (value) => ipcRenderer.invoke("conversation:context-trace", value),
    focus: (value) => ipcRenderer.invoke("conversation:focus", value),
    openMediaDirectory: (value) => ipcRenderer.invoke("conversation:open-media-directory", value),
    openMediaFile: (value) => ipcRenderer.invoke("conversation:open-media-file", value),
    create: () => ipcRenderer.invoke("conversation:create"),
    createContact: (value) => ipcRenderer.invoke("conversation:create-contact", value),
    renameContact: (value) => ipcRenderer.invoke("conversation:rename-contact", value),
    selectContact: (value) => ipcRenderer.invoke("conversation:select-contact", value),
    setPreferredContact: (value) => ipcRenderer.invoke("conversation:set-preferred-contact", value),
    updateContactPresentation: (value) => ipcRenderer.invoke("conversation:update-contact-presentation", value),
    updateContactLongTermMemoryEnabled: (value) => ipcRenderer.invoke("conversation:update-contact-long-term-memory", value),
    updateContactPermissionMode: (value) => ipcRenderer.invoke("conversation:update-contact-permission-mode", value),
    removeContact: (value) => ipcRenderer.invoke("conversation:remove-contact", value),
    attachments: {
      select: (value) => ipcRenderer.invoke("conversation:select-attachments", value),
      discard: (value) => ipcRenderer.invoke("conversation:discard-attachments", value),
    },
    emojiStickers: {
      snapshot: () => ipcRenderer.invoke("conversation:emoji-stickers"),
      select: () => ipcRenderer.invoke("conversation:select-emoji-sticker"),
      add: (value) => ipcRenderer.invoke("conversation:add-emoji-sticker", value),
      send: (value) => ipcRenderer.invoke("conversation:send-emoji-sticker", value),
    },
    send: (value) => ipcRenderer.invoke("conversation:send", value),
    stop: (value) => ipcRenderer.invoke("conversation:stop", value),
    steer: (value) => ipcRenderer.invoke("conversation:steer", value),
    call: {
      start: (value) => ipcRenderer.invoke("conversation:call-start", value),
      open: (value) => ipcRenderer.invoke("conversation:call-open", value),
      audio: (value) => ipcRenderer.send("conversation:call-audio", value),
      commit: (value) => ipcRenderer.invoke("conversation:call-commit", value),
      interrupt: (value) => ipcRenderer.invoke("conversation:call-interrupt", value),
      stop: (value) => ipcRenderer.invoke("conversation:call-stop", value),
    },
    voiceInput: {
      start: () => ipcRenderer.invoke("conversation:voice-input-start"),
      audio: (value) => ipcRenderer.send("conversation:voice-input-audio", value),
      commit: (value) => ipcRenderer.invoke("conversation:voice-input-commit", value),
      stop: (value) => ipcRenderer.invoke("conversation:voice-input-stop", value),
    },
    respondPermission: (value) => ipcRenderer.invoke("conversation:respond-permission", value),
    onEvent: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("conversation:event", listener);
      return () => ipcRenderer.removeListener("conversation:event", listener);
    },
  },
  conversationCompactor: {
    run: (value = {}) => ipcRenderer.invoke("conversation-compactor:run", value),
    save: (value = {}) => ipcRenderer.invoke("conversation-compactor:save", value),
    snapshot: (value = {}) => ipcRenderer.invoke("conversation-compactor:snapshot", value),
  },
  softwareAssistant: {
    snapshot: () => ipcRenderer.invoke("software-assistant:snapshot"),
    send: (value) => ipcRenderer.invoke("software-assistant:send", value),
    stop: (value = {}) => ipcRenderer.invoke("software-assistant:stop", value),
    onEvent: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("software-assistant:event", listener);
      return () => ipcRenderer.removeListener("software-assistant:event", listener);
    },
  },
  agentJournal: {
    snapshot: (value = {}) => ipcRenderer.invoke("agent-journal:snapshot", value),
  },
  schedule: {
    snapshot: () => ipcRenderer.invoke("schedule:snapshot"),
    selectScript: () => ipcRenderer.invoke("schedule:select-script"),
    create: (value) => ipcRenderer.invoke("schedule:create", value),
    setEnabled: (value) => ipcRenderer.invoke("schedule:set-enabled", value),
    remove: (value) => ipcRenderer.invoke("schedule:remove", value),
  },
  wechat: {
    snapshot: (value) => ipcRenderer.invoke("wechat:snapshot", value),
    begin: (value) => ipcRenderer.invoke("wechat:begin", value),
    saveSettings: (value) => ipcRenderer.invoke("wechat:save-settings", value),
    setContactEnabled: (value) => ipcRenderer.invoke("wechat:set-contact-enabled", value),
    disconnect: (value) => ipcRenderer.invoke("wechat:disconnect", value),
    onEvent: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("wechat:event", listener);
      return () => ipcRenderer.removeListener("wechat:event", listener);
    },
  },
  relationshipFiles: {
    snapshot: () => ipcRenderer.invoke("relationship-files:snapshot"),
    save: (value) => ipcRenderer.invoke("relationship-files:save", value),
    create: (value) => ipcRenderer.invoke("relationship-files:create", value),
  },
  connections: {
    comfyuiSnapshot: () => ipcRenderer.invoke("connections:comfyui-snapshot"),
    saveComfyui: (value) => ipcRenderer.invoke("connections:save-comfyui", value),
    apiServicesSnapshot: () => ipcRenderer.invoke("connections:api-services-snapshot"),
    saveNamedApiConnection: (value) => ipcRenderer.invoke("connections:save-named-api", value),
    removeNamedApiConnection: (id) => ipcRenderer.invoke("connections:remove-named-api", id),
    bindNamedApiConnection: (feature, connectionId) => ipcRenderer.invoke("connections:bind-named-api", feature, connectionId),
  },
  imageWorkbench: {
    snapshot: () => ipcRenderer.invoke("image-workbench:snapshot"),
    generate: (value) => ipcRenderer.invoke("image-workbench:generate", value),
    thumbnail: (runId, candidateId) => ipcRenderer.invoke("image-workbench:thumbnail", runId, candidateId),
  },
  visualReferences: {
    snapshot: () => ipcRenderer.invoke("visual-references:snapshot"),
    selectImage: (role) => ipcRenderer.invoke("visual-references:select-image", role),
    add: (value) => ipcRenderer.invoke("visual-references:add", value),
    update: (value) => ipcRenderer.invoke("visual-references:update", value),
    upsertSet: (value) => ipcRenderer.invoke("visual-references:upsert-set", value),
    removeSet: (value) => ipcRenderer.invoke("visual-references:remove-set", value),
    remove: (value) => ipcRenderer.invoke("visual-references:remove", value),
    thumbnail: (reference) => ipcRenderer.invoke("visual-references:thumbnail", reference),
  },
  voiceDesign: {
    snapshot: () => ipcRenderer.invoke("voice-design:snapshot"),
    deleteCustomVoice: (value) => ipcRenderer.invoke("voice-design:delete-custom-voice", value),
    saveCustomAudio: (value) => ipcRenderer.invoke("voice-design:save-custom-audio", value),
    saveContactVoice: (value) => ipcRenderer.invoke("voice-design:save-contact-voice", value),
  },
  memory: {
    status: (scope = {}) => ipcRenderer.invoke("memory:status", scope),
    search: (query, scope = {}) => ipcRenderer.invoke("memory:search", { query, ...scope }),
    brainGraph: (scope = {}) => ipcRenderer.invoke("memory:brain-graph", scope),
    list: (filters) => ipcRenderer.invoke("memory:list", filters),
    detail: (memoryId, scope = {}) => ipcRenderer.invoke("memory:detail", { memoryId, ...scope }),
    edit: (memoryId, patch, reason = "", scope = {}) => ipcRenderer.invoke(
      "memory:edit",
      { memoryId, patch, reason, ...scope },
    ),
    remove: (memoryId, reason = "", scope = {}) => ipcRenderer.invoke(
      "memory:delete",
      { memoryId, reason, ...scope },
    ),
    restore: (memoryId, reason = "", scope = {}) => ipcRenderer.invoke(
      "memory:restore",
      { memoryId, reason, ...scope },
    ),
    reviewOverview: (filters = {}) => ipcRenderer.invoke(
      "memory:review-overview",
      filters,
    ),
    reviewProposal: (type, proposalId, scope = {}) => ipcRenderer.invoke(
      "memory:review-proposal",
      { type, proposalId, ...scope },
    ),
    resolveReview: (type, proposalId, action, note = "", scope = {}) => ipcRenderer.invoke(
      "memory:resolve-review",
      { type, proposalId, action, note, ...scope },
    ),
    retryLongTermExtractionReview: (proposalId, note = "", scope = {}) => ipcRenderer.invoke(
      "memory:retry-long-term-extraction-review",
      { proposalId, note, ...scope },
    ),
    revokeReviewRelation: (proposalId, note = "", scope = {}) => ipcRenderer.invoke(
      "memory:revoke-review-relation",
      { proposalId, note, ...scope },
    ),
    recoverReviewInputBatch: (batchId, force = false, scope = {}) => ipcRenderer.invoke(
      "memory:recover-review-input-batch",
      { batchId, force, ...scope },
    ),
    createReviewBackup: (scope = {}) => ipcRenderer.invoke("memory:create-review-backup", scope),
    selectReviewBackup: () => ipcRenderer.invoke("memory:select-review-backup"),
    selectImportDatabase: () => ipcRenderer.invoke("memory:select-import-database"),
    inspectReviewBackup: (sourcePath, scope = {}) => ipcRenderer.invoke(
      "memory:inspect-review-backup",
      { sourcePath, ...scope },
    ),
    inspectImportDatabase: (sourcePath, scope = {}) => ipcRenderer.invoke(
      "memory:inspect-import-database",
      { sourcePath, ...scope },
    ),
    restoreReviewBackup: (sourcePath, scope = {}) => ipcRenderer.invoke(
      "memory:restore-review-backup",
      { sourcePath, ...scope },
    ),
    importDatabase: (sourcePath, scope = {}) => ipcRenderer.invoke(
      "memory:import-database",
      { sourcePath, ...scope },
    ),
  },
});
