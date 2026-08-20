import assert from "node:assert/strict";
import test from "node:test";

import {
  createReleaseAnnouncementService,
  normalizeReleaseAnnouncement,
} from "../electron/services/release-announcement.mjs";
import { CURRENT_RELEASE_ANNOUNCEMENT } from "../shared/current-release-announcement.mjs";

const ANNOUNCEMENT = {
  title: "本次更新",
  summary: "这里是当前版本的公告。",
  items: ["第一项", "第一项", "第二项"],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function serviceFixture({
  hadStoredSettings = false,
  settings = {},
  version = "1.2.0",
} = {}) {
  let stored = clone(settings);
  const settingsService = {
    hasStoredSettings: () => hadStoredSettings,
    load: () => clone(stored),
    save: (next) => {
      stored = clone(next);
      return clone(stored);
    },
  };
  return {
    service: createReleaseAnnouncementService({
      app: { getVersion: () => version },
      announcement: ANNOUNCEMENT,
      settingsService,
    }),
    settings: () => clone(stored),
  };
}

test("a fresh installation records the version without showing an announcement", () => {
  const fixture = serviceFixture();

  const status = fixture.service.status();

  assert.equal(status.pending, false);
  assert.equal(status.version, "1.2.0");
  assert.deepEqual(status.announcement.items, ["第一项", "第二项"]);
  assert.deepEqual(fixture.settings().releaseAnnouncementState, {
    lastAcknowledgedVersion: "1.2.0",
    lastStartedVersion: "1.2.0",
  });
});

test("an existing installation migrating from an older version shows the current announcement once", () => {
  const fixture = serviceFixture({ hadStoredSettings: true, settings: { theme: "dark" } });

  assert.equal(fixture.service.status().pending, true);
  assert.equal(fixture.service.acknowledge().pending, false);
  assert.deepEqual(fixture.settings().releaseAnnouncementState, {
    lastAcknowledgedVersion: "1.2.0",
    lastStartedVersion: "1.2.0",
  });
  assert.equal(fixture.service.status().pending, false);
});

test("a later version is the one current announcement; no announcement history is retained", () => {
  const initial = serviceFixture({
    hadStoredSettings: true,
    settings: {
      releaseAnnouncementState: {
        lastAcknowledgedVersion: "1.1.0",
        lastStartedVersion: "1.1.0",
      },
    },
    version: "1.2.0",
  });

  const status = initial.service.status();

  assert.equal(status.pending, true);
  assert.equal(status.announcement.version, "1.2.0");
  assert.deepEqual(Object.keys(initial.settings().releaseAnnouncementState).sort(), [
    "lastAcknowledgedVersion",
    "lastStartedVersion",
  ]);
});

test("an empty current announcement never creates a popup", () => {
  const service = createReleaseAnnouncementService({
    app: { getVersion: () => "1.2.0" },
    settingsService: {
      hasStoredSettings: () => true,
      load: () => ({}),
      save: () => ({}),
    },
  });

  assert.equal(service.status().announcement, null);
  assert.equal(service.status().pending, false);
  assert.equal(normalizeReleaseAnnouncement({}), null);
});

test("the v0.2 release announcement uses the Suzu runtime name, not its upstream implementation name", () => {
  const text = [CURRENT_RELEASE_ANNOUNCEMENT.title, CURRENT_RELEASE_ANNOUNCEMENT.summary, ...CURRENT_RELEASE_ANNOUNCEMENT.items].join("\n");

  assert.match(text, /Suzu.*Agent Core/u);
  assert.doesNotMatch(text, /\bDSH\b/u);
});
