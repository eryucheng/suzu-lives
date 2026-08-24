import { getIdentity } from "./identity.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Resolves the avatar owned by a contact's Agent identity. Contacts without a
 * dedicated avatar inherit the configured default Agent avatar.
 */
export function contactAvatarSource(contact, settings) {
  const identity = getIdentity(settings);
  const agentId = clean(contact?.agentId);
  return clean(identity?.agents?.[agentId]?.avatarDataUrl || identity?.defaultAgent?.avatarDataUrl);
}
