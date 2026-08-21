export function registerTodayCalendarIpc({ ipcMain, todayCalendarService }) {
  ipcMain.handle("today-calendar:snapshot", (_event, value) => todayCalendarService.snapshot(value));
  ipcMain.handle("today-calendar:save-event", (_event, value) => todayCalendarService.saveEvent(value));
  ipcMain.handle("today-calendar:remove-event", (_event, value) => todayCalendarService.removeEvent(value));
}
