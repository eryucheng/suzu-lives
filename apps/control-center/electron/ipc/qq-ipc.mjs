export function registerQQIpc({ app, ipcMain, qqService }) {
  if (!qqService?.begin || !qqService?.configure || !qqService?.disconnect || !qqService?.saveSettings || !qqService?.setContactEnabled || !qqService?.snapshot) {
    throw new Error("QQ 连接服务不可用。 ");
  }
  let sender = null;
  const rememberSender = (event) => {
    sender = event?.sender || sender;
  };
  const unsubscribe = qqService.subscribe?.((payload) => {
    if (sender && !sender.isDestroyed()) sender.send("qq:event", payload);
  });

  ipcMain.handle("qq:snapshot", async (event, value) => {
    rememberSender(event);
    return qqService.snapshot(value);
  });
  ipcMain.handle("qq:begin", async (event, value) => {
    rememberSender(event);
    return qqService.begin(value);
  });
  ipcMain.handle("qq:configure", async (event, value) => {
    rememberSender(event);
    return qqService.configure(value);
  });
  ipcMain.handle("qq:save-settings", async (event, value) => {
    rememberSender(event);
    return qqService.saveSettings(value);
  });
  ipcMain.handle("qq:set-contact-enabled", async (event, value) => {
    rememberSender(event);
    return qqService.setContactEnabled(value);
  });
  ipcMain.handle("qq:disconnect", async (event, value) => {
    rememberSender(event);
    return qqService.disconnect(value);
  });
  app?.once?.("before-quit", () => {
    unsubscribe?.();
    qqService.dispose?.();
  });
}
