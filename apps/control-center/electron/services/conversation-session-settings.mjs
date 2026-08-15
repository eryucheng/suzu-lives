import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentConversationDataRoot } from "@suzu-lives/agent-registry";

export class ConversationSessionSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationSessionSettingsError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function sessionDirectory(dataRoot, session) {
  try {
    return resolveAgentConversationDataRoot({
      dataRoot,
      projectRoot: clean(session?.projectRoot),
      sessionId: clean(session?.id),
    });
  } catch {
    throw new ConversationSessionSettingsError("联系人数据目录无效。 ");
  }
}

/** Local media lives below the owning Agent and Claude session. */
export function createConversationSessionSettingsService({
  dataRoot,
  fsOps = fs,
  reader,
} = {}) {
  if (!reader?.resolveContactSession) throw new ConversationSessionSettingsError("联系人设置需要联系人读取服务。 ");
  if (!clean(dataRoot) || !path.isAbsolute(clean(dataRoot))) throw new ConversationSessionSettingsError("无法定位 Suzu Lives 软件数据目录。 ");

  const mediaDirectory = async ({ contactId } = {}) => {
    const session = await reader.resolveContactSession(contactId);
    const directory = path.join(sessionDirectory(dataRoot, session), "attachments");
    await fsOps.mkdir(directory, { recursive: true });
    return { contactId: clean(session.contactId ?? contactId), directory };
  };

  return { mediaDirectory };
}
