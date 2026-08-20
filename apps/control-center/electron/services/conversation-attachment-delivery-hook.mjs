import path from "node:path";

/**
 * A product execution instruction, not user-authored persona. It is injected
 * only for the active Agent Core request so an existing companion session learns the
 * current attachment-delivery action without a preset recompose.
 */
export const ATTACHMENT_DELIVERY_HOOK_MOUNT = Object.freeze({
  id: "conversation-attachment-delivery",
  lifecycleEvent: "DynamicContextCollect",
  order: -90,
  policy: "observe",
  timeoutMs: 3_000,
});

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function clean(value) {
  return String(value ?? "").trim();
}

function absoluteDirectory(value) {
  const source = clean(value);
  return source && path.isAbsolute(source) ? path.resolve(source) : "";
}

/**
 * Makes the current built-in product action discoverable in every companion
 * turn. The action itself stays behind the existing Agent Core capability bridge;
 * this Hook owns no file access and does not grant new terminal permissions.
 */
export function createConversationAttachmentDeliveryHook() {
  const collect = (payload = {}) => {
    const sessionId = clean(payload?.sessionId);
    const projectRoot = absoluteDirectory(payload?.projectRoot);
    if (!SESSION_ID.test(sessionId) || !projectRoot) return null;
    return Object.freeze({
      id: `conversation-attachment-delivery:${sessionId}`,
      kind: "conversation-attachment-delivery",
      source: "suzu-runtime",
      display: Object.freeze({
        category: "capability",
        context: true,
        label: "聊天附件交付",
        transcript: false,
      }),
      priority: ATTACHMENT_DELIVERY_HOOK_MOUNT.order,
      metadata: Object.freeze({
        action: "deliver",
        capabilityId: "conversation-attachment",
      }),
      text: [
        "产品能力说明：如果你已经创建了一张图片、MP3 或其他本地文件，并且要把它实际交付给用户，不要只回复本地路径。",
        "先调用 suzu_capability_catalog，再调用其中声明的 conversation-attachment.deliver。",
        "交付输入为 { items: [{ path: \"绝对路径\", kind: \"image\" | \"audio\" | \"file\" }] }。仅在动作成功后才说文件已经发出。",
        "如果当前会话由已绑定的微信联系人发起，Suzu 会根据这次成功交付自动转发同一附件；不要再用其他方式重复发送。",
      ].join("\n"),
    });
  };
  return Object.freeze({ collect });
}
