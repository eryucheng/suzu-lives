import path from "node:path";

import { collectAgentImageAttachmentIds } from "./agent-session-storage.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function agentContactScope(contact) {
  const sessionId = clean(contact?.sessionId);
  const projectRoot = clean(contact?.projectRoot);
  if (!sessionId || !projectRoot || !path.isAbsolute(projectRoot)) return null;
  return { sessionId, projectRoot: path.resolve(projectRoot) };
}

function agentHistorySequence(entry) {
  const value = Number(plainObject(entry).event?.seq);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Reads every Agent Core history page, rather than treating the UI's tail window as
 * the authoritative attachment reference set used for irreversible cleanup. */
async function completeAgentHistory(runtime, { contactId, projectRoot, sessionId }) {
  if (typeof runtime?.history !== "function") throw new Error("Suzu Agent 会话运行时不支持完整历史读取。 ");
  const events = [];
  let beforeSeq;
  for (let pageCount = 0; pageCount < 10_000; pageCount += 1) {
    const page = await runtime.history({
      sessionId,
      contactId,
      cwd: projectRoot,
      maxMessages: 2_000,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    const records = Array.isArray(page?.events) ? page.events : [];
    events.push(...records);
    if (page?.hasMore !== true) return events;
    const sequences = records.map(agentHistorySequence).filter((value) => value !== null);
    const oldest = sequences.length ? Math.min(...sequences) : null;
    if (oldest === null || (beforeSeq !== undefined && oldest >= beforeSeq)) {
      throw new Error("Agent 历史分页未能前进，未执行联系人删除。 ");
    }
    beforeSeq = oldest;
  }
  throw new Error("Agent 历史记录过长，无法安全确认附件引用。 ");
}

function storedSessionValidationFailure(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current === "object") {
      if (seen.has(current)) return false;
      seen.add(current);
    }
    if (/\bstored session\b[\s\S]*\bfailed validation\b/iu.test(clean(current?.message || current))) return true;
    current = current && typeof current === "object" ? current.cause : null;
  }
  return false;
}

async function historyForAttachmentCleanup(runtime, scope) {
  try {
    return { events: await completeAgentHistory(runtime, scope), verified: true };
  } catch (error) {
    // A pre-existing malformed durable log cannot tell us which attachment
    // objects are exclusive to this contact. Deletion can still safely remove
    // the known session and contact data as long as all attachment objects are
    // retained; an unrelated runtime failure remains a real deletion failure.
    if (!storedSessionValidationFailure(error)) throw error;
    return { events: [], verified: false };
  }
}

/**
 * Deletes one contact's owned Agent session. A malformed historical session is
 * not allowed to strand the contact forever: it falls back to retaining every
 * uncertain attachment object, rather than risking a shared-image deletion.
 */
export async function eraseContactAgentConversation({ contact, contactProjectsService, conversation }) {
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
  const catalog = await contactProjectsService.snapshot();
  const contacts = Array.isArray(catalog?.contacts) ? catalog.contacts : [];
  const targetHistory = await historyForAttachmentCleanup(runtime, {
    contactId: clean(contact?.id),
    ...target,
  });
  let attachmentsVerified = targetHistory.verified;
  const protectedAttachmentIds = new Set();
  if (attachmentsVerified) {
    for (const candidate of contacts) {
      if (clean(candidate?.id) === clean(contact?.id)) continue;
      const scope = agentContactScope(candidate);
      if (!scope) continue;
      const candidateHistory = await historyForAttachmentCleanup(runtime, {
        contactId: clean(candidate?.id),
        ...scope,
      });
      if (!candidateHistory.verified) {
        attachmentsVerified = false;
        break;
      }
      for (const id of collectAgentImageAttachmentIds(candidateHistory.events)) protectedAttachmentIds.add(id);
    }
  }
  const storage = await runtime.purgeSession({
    sessionId: target.sessionId,
    cwd: target.projectRoot,
    imageAttachmentIds: attachmentsVerified ? collectAgentImageAttachmentIds(targetHistory.events) : [],
    protectedImageAttachmentIds: attachmentsVerified ? [...protectedAttachmentIds] : [],
  });
  return {
    status: "deleted",
    attachmentCleanup: attachmentsVerified ? "verified" : "retained-unverified",
    ...storage,
  };
}
