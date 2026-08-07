export function registerWechatIpc({ app, ipcMain, wechatService }) {
  if (!wechatService?.begin || !wechatService?.disconnect || !wechatService?.saveSettings || !wechatService?.setSessionEnabled || !wechatService?.snapshot) {
    throw new Error("微信连接服务不可用。");
  }
  let sender = null;
  const rememberSender = (event) => {
    sender = event?.sender || sender;
  };
  const unsubscribe = wechatService.subscribe?.((payload) => {
    if (sender && !sender.isDestroyed()) sender.send("wechat:event", payload);
  });

  ipcMain.handle("wechat:snapshot", async (event, value) => {
    rememberSender(event);
    return wechatService.snapshot(value);
  });
  ipcMain.handle("wechat:begin", async (event, value) => {
    rememberSender(event);
    return wechatService.begin(value);
  });
  ipcMain.handle("wechat:save-settings", async (event, value) => {
    rememberSender(event);
    return wechatService.saveSettings(value);
  });
  ipcMain.handle("wechat:set-session-enabled", async (event, value) => {
    rememberSender(event);
    return wechatService.setSessionEnabled(value);
  });
  ipcMain.handle("wechat:disconnect", async (event, value) => {
    rememberSender(event);
    return wechatService.disconnect(value);
  });
  app?.once?.("before-quit", () => {
    unsubscribe?.();
    wechatService.dispose?.();
  });
}
