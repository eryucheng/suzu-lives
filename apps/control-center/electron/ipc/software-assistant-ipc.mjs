function clean(value) {
  return String(value ?? "").trim();
}

function request(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { content: typeof source.content === "string" ? source.content : "" };
}

/** Renderer bridge for the fixed, non-contact software-help conversation. */
export function registerSoftwareAssistantIpc({ app = null, ipcMain, softwareAssistantService } = {}) {
  if (!ipcMain?.handle || !softwareAssistantService?.snapshot || !softwareAssistantService?.send || !softwareAssistantService?.stop || !softwareAssistantService?.subscribe) {
    throw new Error("软件助手 IPC 需要完整的软件助手服务。 ");
  }
  const senders = new Set();
  const remember = (sender) => {
    if (sender && !sender.isDestroyed?.()) senders.add(sender);
  };
  const unsubscribe = softwareAssistantService.subscribe((payload) => {
    for (const sender of [...senders]) {
      if (sender?.isDestroyed?.()) {
        senders.delete(sender);
        continue;
      }
      try { sender.send("software-assistant:event", payload); } catch { senders.delete(sender); }
    }
  });
  ipcMain.handle("software-assistant:snapshot", (event) => {
    remember(event.sender);
    return softwareAssistantService.snapshot();
  });
  ipcMain.handle("software-assistant:send", async (event, value) => {
    remember(event.sender);
    return softwareAssistantService.send(request(value));
  });
  ipcMain.handle("software-assistant:stop", async (event, value) => {
    remember(event.sender);
    return softwareAssistantService.stop({ requestId: clean(value?.requestId) });
  });
  app?.once?.("before-quit", () => {
    try { unsubscribe?.(); } catch { /* Process shutdown. */ }
    senders.clear();
    softwareAssistantService.dispose?.();
  });
  return softwareAssistantService;
}
