import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseTravelingMerchantArgs,
  renderTravelingMerchantSkill,
  resolveTravelingMerchantConfigPath,
  runTravelingMerchantCli,
  TravelingMerchantError,
} from "../src/index.mjs";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function softwareEnvironment(root) {
  return {
    ...process.env,
    SUZU_LIVES_DATA_ROOT: root,
  };
}

test("merchant parser keeps supported flags and software-side configuration boundaries", () => {
  assert.deepEqual(
    parseTravelingMerchantArgs(["--dry-run", "--force", "--fixture", "fixture.html", "--config", "automation/traveling-merchant/config.json", "--data-root", "D:/data"]),
    {
      dryRun: true,
      force: true,
      fixture: "fixture.html",
      testNotification: false,
      configPath: "automation/traveling-merchant/config.json",
      dataRoot: "D:/data",
    },
  );
  assert.equal(
    resolveTravelingMerchantConfigPath({ dataRoot: "D:/data", configPath: "automation/traveling-merchant/config.json" }),
    path.resolve("D:/data", "automation/traveling-merchant/config.json"),
  );
  assert.throws(
    () => resolveTravelingMerchantConfigPath({ dataRoot: "D:/data", configPath: "../outside/config.json" }),
    TravelingMerchantError,
  );
});

test("merchant fixture parsing prepares a Suzu-owned delivery result and state", () => {
  const root = temporaryDirectory("suzu-merchant-");
  const fixture = path.join(root, "merchant.html");
  fs.writeFileSync(
    fixture,
    '<div class="notice">棱镜球、炫彩蛋提醒</div><div>8-12点在售商品</div><span class="shop_name">棱镜球</span><span class="shop_name"><b>其他物品</b></span>',
    "utf8",
  );
  const environment = softwareEnvironment(root);
  const dryRun = runTravelingMerchantCli(["--dry-run", "--fixture", fixture], { environment });
  const dryResult = JSON.parse(dryRun.stdout);
  const statePath = path.join(root, "automation", "traveling-merchant", "runtime", "state.json");
  assert.equal(dryRun.code, 0);
  assert.equal(dryResult.status, "match");
  assert.deepEqual(dryResult.items, ["棱镜球", "其他物品"]);
  assert.deepEqual(dryResult.foundItems, ["棱镜球"]);
  assert.equal(dryResult.deliveryReady, false);
  assert.equal(fs.existsSync(statePath), false);

  const prepared = runTravelingMerchantCli(["--fixture", fixture], { environment });
  const preparedResult = JSON.parse(prepared.stdout);
  assert.equal(prepared.code, 0);
  assert.equal(preparedResult.deliveryReady, true);
  assert.equal(preparedResult.message, "远行商人这轮有：棱镜球，快去买");
  assert.equal(fs.existsSync(statePath), true);
  assert.equal(path.dirname(path.dirname(path.dirname(statePath))), path.join(root, "automation"));

  const notification = runTravelingMerchantCli(["--test-notification"], { environment });
  const notificationResult = JSON.parse(notification.stdout);
  assert.equal(notification.code, 0);
  assert.equal(notificationResult.status, "test-notification-ready");
  assert.equal(notificationResult.message, "【测试】远行商人监控投递内容");
  assert.equal(notificationResult.deliveryReady, true);
});

test("merchant Skill uses stable Suzu Lives schedule forms without private paths", () => {
  const skill = renderTravelingMerchantSkill();
  assert.match(skill, /suzu-lives traveling-merchant/u);
  assert.match(skill, /suzu-lives schedule add --cron "2 8,12,16,20 \* \* \*" --exec traveling-merchant --desc "洛克王国远行商人监控"/u);
  assert.match(skill, /suzu-lives schedule list/u);
  assert.match(skill, /suzu-lives schedule remove <旧任务ID>/u);
  assert.doesNotMatch(skill, /D:\\Apps|config\.local|registry\.local|(?:^|[\\/])ling(?:[\\/]|$)/iu);
});
