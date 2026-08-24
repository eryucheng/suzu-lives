function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredScope(context) {
  const source = plainObject(context);
  const contactId = clean(source.contactId);
  const projectRoot = clean(source.projectRoot);
  const sessionId = clean(source.sessionId);
  if (!contactId || !projectRoot || !sessionId) {
    throw new Error("语音通话能力只能在当前联系人的有效对话中调用。 ");
  }
  return { contactId, projectRoot, sessionId };
}

function optionalReason(context) {
  const reason = clean(plainObject(plainObject(context).input).reason);
  if (reason.length > 160) throw new Error("来电说明不能超过 160 个字符。 ");
  return reason;
}

/**
 * Routes the companion's call Skill through the desktop-owned call service.
 * A terminal command cannot safely own renderer microphone state or decide
 * which contact may be called, so the existing capability bridge supplies the
 * trusted turn scope here instead.
 */
export function createAgentVoiceCallCapabilityAdapter({ voiceCallService = () => null } = {}) {
  if (typeof voiceCallService !== "function") {
    throw new Error("Agent 语音通话能力需要通话服务提供器。 ");
  }
  return async ({ action, capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") {
      return {
        status: "ready",
        capabilityId: clean(capability?.id),
        lifecycle: clean(lifecycle),
        runtime: "agent-capability-bridge",
      };
    }
    const service = voiceCallService();
    const actionId = clean(action?.action);
    const scope = requiredScope(context);
    if (actionId === "dial") {
      if (typeof service?.dialFromAgent !== "function") {
        throw new Error("实时语音通话服务尚未就绪。 ");
      }
      return service.dialFromAgent({ ...scope, reason: optionalReason(context) });
    }
    if (actionId === "hangup") {
      if (typeof service?.hangupFromAgent !== "function") {
        throw new Error("实时语音通话服务尚未就绪。 ");
      }
      return service.hangupFromAgent(scope);
    }
    throw new Error("当前语音通话动作不可用。 ");
  };
}
