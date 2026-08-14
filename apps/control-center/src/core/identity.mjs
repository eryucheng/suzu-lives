const FALLBACK_IDENTITY = Object.freeze({
  owner: { displayName: "我", avatarDataUrl: "", gender: "", signature: "" },
  defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
  agents: {},
});

export function getIdentity(settings) {
  return settings?.identity || FALLBACK_IDENTITY;
}

export function getAgentProfile(settings) {
  const identity = getIdentity(settings);
  return identity.agents?.[settings?.agentId] || identity.defaultAgent || FALLBACK_IDENTITY.defaultAgent;
}

export function profileInitial(profile, fallback = "?") {
  return String(profile?.displayName || fallback).trim().slice(0, 1).toUpperCase() || fallback;
}
