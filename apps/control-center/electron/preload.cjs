const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("suzuConsole", {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    selectProject: () => ipcRenderer.invoke("settings:select-project"),
    changeDataLocation: () => ipcRenderer.invoke("settings:change-data-location"),
    removePreviousDataCopy: () => ipcRenderer.invoke("settings:remove-previous-data-copy"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    showItemInFolder: (targetPath) => ipcRenderer.invoke("shell:show-item", targetPath),
  },
  ledger: {
    scan: () => ipcRenderer.invoke("ledger:scan"),
  },
  todayCalendar: {
    snapshot: () => ipcRenderer.invoke("today-calendar:snapshot"),
    saveEvent: (value) => ipcRenderer.invoke("today-calendar:save-event", value),
    removeEvent: (id) => ipcRenderer.invoke("today-calendar:remove-event", id),
  },
  capabilities: {
    snapshot: () => ipcRenderer.invoke("capabilities:snapshot"),
    register: (id) => ipcRenderer.invoke("capabilities:register", id),
    setActive: (id, enabled) => ipcRenderer.invoke("capabilities:set-active", { id, enabled }),
    enable: (id) => ipcRenderer.invoke("capabilities:enable", id),
    initializeDefaults: () => ipcRenderer.invoke("capabilities:initialize-defaults"),
    saveSettings: (id, value) => ipcRenderer.invoke("capabilities:save-settings", { id, value }),
    openTravelingMerchantPage: () => ipcRenderer.invoke("capabilities:open-traveling-merchant-page"),
  },
  externalCapabilities: {
    snapshot: () => ipcRenderer.invoke("external-capabilities:snapshot"),
    importManifest: () => ipcRenderer.invoke("external-capabilities:import"),
    setEnabled: (id, enabled) => ipcRenderer.invoke("external-capabilities:set-enabled", { id, enabled }),
    remove: (id, confirmed = false) => ipcRenderer.invoke("external-capabilities:remove", { id, confirmed }),
  },
  agentRuntime: {
    snapshot: () => ipcRenderer.invoke("agent-runtime:snapshot"),
    claudeCodeApiSnapshot: () => ipcRenderer.invoke("agent-runtime:claude-code-api-snapshot"),
    saveClaude: (value) => ipcRenderer.invoke("agent-runtime:save-claude", value),
    saveClaudeCodeApi: (value) => ipcRenderer.invoke("agent-runtime:save-claude-code-api", value),
    fetchClaudeCodeModels: (value) => ipcRenderer.invoke("agent-runtime:fetch-claude-code-models", value),
  },
  conversation: {
    snapshot: () => ipcRenderer.invoke("conversation:snapshot"),
    search: (query) => ipcRenderer.invoke("conversation:search", query),
    focus: (value) => ipcRenderer.invoke("conversation:focus", value),
    sessionSettingsSnapshot: (value) => ipcRenderer.invoke("conversation:session-settings-snapshot", value),
    saveSessionSettings: (value) => ipcRenderer.invoke("conversation:save-session-settings", value),
    openMediaDirectory: (value) => ipcRenderer.invoke("conversation:open-media-directory", value),
    create: () => ipcRenderer.invoke("conversation:create"),
    createContact: (value) => ipcRenderer.invoke("conversation:create-contact", value),
    select: (sessionId) => ipcRenderer.invoke("conversation:select", sessionId),
    selectContact: (value) => ipcRenderer.invoke("conversation:select-contact", value),
    send: (value) => ipcRenderer.invoke("conversation:send", value),
    stop: (value) => ipcRenderer.invoke("conversation:stop", value),
    steer: (value) => ipcRenderer.invoke("conversation:steer", value),
    call: {
      start: () => ipcRenderer.invoke("conversation:call-start"),
      audio: (value) => ipcRenderer.send("conversation:call-audio", value),
      commit: (value) => ipcRenderer.invoke("conversation:call-commit", value),
      interrupt: (value) => ipcRenderer.invoke("conversation:call-interrupt", value),
      stop: (value) => ipcRenderer.invoke("conversation:call-stop", value),
    },
    respondPermission: (value) => ipcRenderer.invoke("conversation:respond-permission", value),
    onEvent: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("conversation:event", listener);
      return () => ipcRenderer.removeListener("conversation:event", listener);
    },
  },
  schedule: {
    snapshot: () => ipcRenderer.invoke("schedule:snapshot"),
  },
  wechat: {
    snapshot: (value) => ipcRenderer.invoke("wechat:snapshot", value),
    begin: (value) => ipcRenderer.invoke("wechat:begin", value),
    saveSettings: (value) => ipcRenderer.invoke("wechat:save-settings", value),
    setSessionEnabled: (value) => ipcRenderer.invoke("wechat:set-session-enabled", value),
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
    dashScopeSnapshot: () => ipcRenderer.invoke("connections:dashscope-snapshot"),
    saveDashScope: (value) => ipcRenderer.invoke("connections:save-dashscope", value),
    clearDashScope: () => ipcRenderer.invoke("connections:clear-dashscope"),
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
    removeSet: (id) => ipcRenderer.invoke("visual-references:remove-set", id),
    remove: (value) => ipcRenderer.invoke("visual-references:remove", value),
    thumbnail: (id) => ipcRenderer.invoke("visual-references:thumbnail", id),
  },
  voiceDesign: {
    snapshot: () => ipcRenderer.invoke("voice-design:snapshot"),
    saveSettings: (value) => ipcRenderer.invoke("voice-design:save-settings", value),
    saveCustomAudio: (value) => ipcRenderer.invoke("voice-design:save-custom-audio", value),
    saveContactVoice: (value) => ipcRenderer.invoke("voice-design:save-contact-voice", value),
    create: (value) => ipcRenderer.invoke("voice-design:create", value),
    renameCandidate: (value) => ipcRenderer.invoke("voice-design:rename-candidate", value),
    retainCandidate: (id) => ipcRenderer.invoke("voice-design:retain-candidate", id),
    deleteCandidate: (id) => ipcRenderer.invoke("voice-design:delete-candidate", id),
    preview: (id) => ipcRenderer.invoke("voice-design:preview", id),
  },
  memory: {
    status: () => ipcRenderer.invoke("memory:status"),
    search: (query) => ipcRenderer.invoke("memory:search", query),
    brainGraph: () => ipcRenderer.invoke("memory:brain-graph"),
    list: (filters) => ipcRenderer.invoke("memory:list", filters),
    detail: (memoryId) => ipcRenderer.invoke("memory:detail", memoryId),
    edit: (memoryId, patch, reason = "") => ipcRenderer.invoke(
      "memory:edit",
      { memoryId, patch, reason },
    ),
    remove: (memoryId, reason = "") => ipcRenderer.invoke(
      "memory:delete",
      { memoryId, reason },
    ),
    restore: (memoryId, reason = "") => ipcRenderer.invoke(
      "memory:restore",
      { memoryId, reason },
    ),
    structureProposals: (filters = {}) => ipcRenderer.invoke(
      "memory:structure-proposals",
      filters,
    ),
    resolveStructure: (proposalId, action, note = "") => ipcRenderer.invoke(
      "memory:resolve-structure",
      { proposalId, action, note },
    ),
    subjectAttributionProposals: (filters = {}) => ipcRenderer.invoke(
      "memory:subject-attribution-proposals",
      filters,
    ),
    resolveSubjectAttribution: (proposalId, action, note = "") => ipcRenderer.invoke(
      "memory:resolve-subject-attribution",
      { proposalId, action, note },
    ),
    retrievalTraces: (filters = {}) => ipcRenderer.invoke(
      "memory:retrieval-traces",
      filters,
    ),
    recordRetrievalFeedback: (traceId, signal, targetMemoryIds = [], note = "") => (
      ipcRenderer.invoke("memory:retrieval-feedback", {
        traceId,
        signal,
        targetMemoryIds,
        note,
      })
    ),
    retrievalStats: (filters = {}) => ipcRenderer.invoke(
      "memory:retrieval-stats",
      filters,
    ),
    edgeRetrievalStats: (filters = {}) => ipcRenderer.invoke(
      "memory:edge-retrieval-stats",
      filters,
    ),
    plasticityPreview: (filters = {}) => ipcRenderer.invoke(
      "memory:plasticity-preview",
      filters,
    ),
  },
});
