function selectedFile(snapshot, selectedPath) {
  return snapshot?.files?.find((file) => file.path === selectedPath) || snapshot?.files?.[0] || null;
}

function applyRelationshipContacts(context, snapshot) {
  context.state.relationshipContacts = {
    contacts: Array.isArray(snapshot?.contacts) ? snapshot.contacts : [],
    activeContact: snapshot?.activeContact || null,
  };
}

export async function loadRelationshipFiles(context, { contactSnapshot = null } = {}) {
  try {
    if (context.api.settings?.get) context.state.settings = await context.api.settings.get().catch(() => context.state.settings);
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
  await loadRelationshipFiles(context, { contactSnapshot: snapshot });
}
