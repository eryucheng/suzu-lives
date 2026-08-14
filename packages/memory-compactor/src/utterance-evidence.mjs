export const DIRECT_USER_AGENT_DM_TOPOLOGY = "direct-user-agent-dm";

function clean(value) {
  return String(value ?? "").trim();
}

function speakerIdentity(messageRole, agentId) {
  if (messageRole === "user") return { actorRole: "user", actorKey: "user" };
  if (messageRole === "assistant" && clean(agentId)) {
    return { actorRole: "agent", actorKey: clean(agentId) };
  }
  return null;
}

export function buildArchivedUtteranceIdentity({
  messageRole,
  agentId,
  conversationTopology = "",
  provenance = "memory-compactor-v2-utterance",
} = {}) {
  const speaker = speakerIdentity(clean(messageRole), agentId);
  if (!speaker) {
    return {
      subjectRole: "unknown",
      subjectKey: "",
      actorRoles: [],
    };
  }

  const actorRoles = [{
    role: "speaker",
    ...speaker,
    isPrimary: true,
    confidence: 1,
    provenance: clean(provenance),
  }];
  if (
    clean(conversationTopology) === DIRECT_USER_AGENT_DM_TOPOLOGY
    && clean(agentId)
  ) {
    actorRoles.push({
      role: "participant",
      actorRole: speaker.actorRole === "user" ? "agent" : "user",
      actorKey: speaker.actorRole === "user" ? clean(agentId) : "user",
      isPrimary: false,
      confidence: 1,
      provenance: `${clean(provenance)}-dm-counterpart`,
    });
  }
  return {
    subjectRole: speaker.actorRole,
    subjectKey: speaker.actorKey,
    actorRoles,
  };
}
