let activeCallStateReader = null;

export function registerConversationCallActivityReader(reader) {
  activeCallStateReader = typeof reader === "function" ? reader : null;
  return () => {
    if (activeCallStateReader === reader) activeCallStateReader = null;
  };
}

export function hasActiveConversationCall() {
  try {
    return Boolean(activeCallStateReader?.());
  } catch {
    return false;
  }
}
