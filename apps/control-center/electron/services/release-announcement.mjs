function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function versionMarker(value) {
  return clean(value).slice(0, 80);
}

export function normalizeReleaseAnnouncementState(value = {}) {
  const source = plainObject(value);
  return {
    lastAcknowledgedVersion: versionMarker(source.lastAcknowledgedVersion),
    lastStartedVersion: versionMarker(source.lastStartedVersion),
  };
}

export function normalizeReleaseAnnouncement(value = {}) {
  const source = plainObject(value);
  const title = clean(source.title).slice(0, 120);
  const summary = clean(source.summary).slice(0, 700);
  const seen = new Set();
  const items = (Array.isArray(source.items) ? source.items : [])
    .map((item) => clean(item).slice(0, 300))
    .filter((item) => item && !seen.has(item) && (seen.add(item), true))
    .slice(0, 8);
  if (!title && !summary && !items.length) return null;
  return {
    items,
    summary,
    title: title || "Suzu Lives 已更新",
  };
}

function appVersion(app) {
  try {
    return versionMarker(app?.getVersion?.());
  } catch {
    return "";
  }
}

function storedSettingsAtLaunch(settingsService) {
  try {
    return settingsService?.hasStoredSettings?.() === true;
  } catch {
    return false;
  }
}

export function createReleaseAnnouncementService({ app, announcement = null, settingsService } = {}) {
  const release = normalizeReleaseAnnouncement(announcement);
  // Capture this before any IPC or first-run code can create settings.json.
  // An existing settings file without our version marker is an upgrade from a
  // pre-announcement version, not a fresh installation.
  const hadStoredSettingsAtLaunch = storedSettingsAtLaunch(settingsService);

  const status = () => {
    const version = appVersion(app);
    if (!version || !settingsService?.load || !settingsService?.save) {
      return { announcement: release ? { ...release, version } : null, pending: false, version };
    }
    const settings = settingsService.load();
    const releaseState = normalizeReleaseAnnouncementState(settings.releaseAnnouncementState);
    const hasStartedBefore = Boolean(releaseState.lastStartedVersion);
    const freshInstall = !hasStartedBefore && !hadStoredSettingsAtLaunch;
    // A fresh install treats its bundled copy as already read.  An upgrade
    // deliberately leaves the acknowledged version untouched, so the popup
    // remains pending across repeated status reads until the user closes it.
    const nextState = {
      ...releaseState,
      lastStartedVersion: version,
      ...(!release || freshInstall ? { lastAcknowledgedVersion: version } : {}),
    };
    const changed = nextState.lastStartedVersion !== releaseState.lastStartedVersion
      || nextState.lastAcknowledgedVersion !== releaseState.lastAcknowledgedVersion;
    if (changed) settingsService.save({ ...settings, releaseAnnouncementState: nextState });
    return {
      announcement: release ? { ...release, version } : null,
      pending: Boolean(release && nextState.lastAcknowledgedVersion !== version),
      version,
    };
  };

  const acknowledge = () => {
    const snapshot = status();
    if (!snapshot.announcement || !settingsService?.load || !settingsService?.save) return { ...snapshot, pending: false };
    const settings = settingsService.load();
    const releaseState = normalizeReleaseAnnouncementState(settings.releaseAnnouncementState);
    settingsService.save({
      ...settings,
      releaseAnnouncementState: { ...releaseState, lastAcknowledgedVersion: snapshot.version },
    });
    return { ...snapshot, pending: false };
  };

  return { acknowledge, status };
}
