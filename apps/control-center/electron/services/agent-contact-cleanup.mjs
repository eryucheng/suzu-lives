import path from "node:path";

function clean(value) {
  return String(value ?? "").trim();
}

function agentContactScope(contact) {
  const sessionId = clean(contact?.sessionId);
  const projectRoot = clean(contact?.projectRoot);
  if (!sessionId || !projectRoot || !path.isAbsolute(projectRoot)) return null;
  return { sessionId, projectRoot: path.resolve(projectRoot) };
}

/**
 * Deletes one contact's owned Agent session. Image objects live in the shared
 * Agent Core attachment store, so contact deletion intentionally retains them;
 * attachment lifecycle belongs to a separate maintenance operation.
 */
export async function eraseContactAgentConversation({ contact, conversation }) {
  const target = agentContactScope(contact);
  if (!target) return { status: "no-agent-session" };
  const runtime = conversation?.agentRuntime;
  if (typeof runtime?.purgeSession !== "function") {
    throw new Error("当前 Suzu Agent 会话运行时不支持完整删除。 ");
  }
  // Stop the visible turn first so the renderer receives the usual stop
  // lifecycle before the owning runtime is shut down below. The hard stop in
  // `purgeSession()` remains the race-free persistence boundary.
  if (typeof conversation?.chat?.stop === "function") {
    await conversation.chat.stop({ sessionId: target.sessionId, projectRoot: target.projectRoot }).catch(() => undefined);
  }
  const storage = await runtime.purgeSession({
    sessionId: target.sessionId,
    cwd: target.projectRoot,
    imageAttachmentIds: [],
    protectedImageAttachmentIds: [],
  });
  return {
    status: "deleted",
    attachmentCleanup: "retained",
    ...storage,
  };
}
