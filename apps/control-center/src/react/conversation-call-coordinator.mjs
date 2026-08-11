let activeEndHandler = null;

export function registerConversationCallEndHandler(handler) {
  activeEndHandler = typeof handler === "function" ? handler : null;
  return () => {
    if (activeEndHandler === handler) activeEndHandler = null;
  };
}

export async function endActiveConversationCall() {
  const handler = activeEndHandler;
  if (!handler) return false;
  try {
    await handler();
    return true;
  } catch {
    return false;
  }
}
