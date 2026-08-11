import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

function readAppFile(...parts) {
  return readFile(resolve(APP_ROOT, ...parts), "utf8");
}

test("React shell owns the design-system frame and keeps the brand in the sidebar", async () => {
  const [html, entry, appShell, shellCss, todayPage, todayCss, plansPage, plansCss, relationshipsPage, relationshipsCss, relationshipSettingsPage, relationshipSettingsCss, conversationPage, conversationPageCss, conversationCss, createPage, createVisualPage, createAudioPage, createCss, capabilitiesPage, capabilityDetailPage, capabilitiesCss, router, app, main, preload, viteConfig] = await Promise.all([
    readAppFile("src", "index.html"),
    readAppFile("src", "main.jsx"),
    readAppFile("src", "react", "app-shell.jsx"),
    readAppFile("src", "react", "app-shell.css"),
    readAppFile("src", "react", "today-page.jsx"),
    readAppFile("src", "react", "today-page.css"),
    readAppFile("src", "react", "plans-page.jsx"),
    readAppFile("src", "react", "plans-page.css"),
    readAppFile("src", "react", "relationships-page.jsx"),
    readAppFile("src", "react", "relationships-page.css"),
    readAppFile("src", "react", "relationship-settings-page.jsx"),
    readAppFile("src", "react", "relationship-settings-page.css"),
    readAppFile("src", "react", "conversation-page.jsx"),
    readAppFile("src", "react", "conversation-page.css"),
    readAppFile("src", "styles", "conversation.css"),
    readAppFile("src", "react", "create-page.jsx"),
    readAppFile("src", "react", "create-visual-page.jsx"),
    readAppFile("src", "react", "create-audio-page.jsx"),
    readAppFile("src", "styles", "create.css"),
    readAppFile("src", "react", "capabilities-page.jsx"),
    readAppFile("src", "react", "capability-detail-page.jsx"),
    readAppFile("src", "react", "capabilities-page.css"),
    readAppFile("src", "react", "app-router.jsx"),
    readAppFile("src", "app.mjs"),
    readAppFile("electron", "main.mjs"),
    readAppFile("electron", "preload.cjs"),
    readAppFile("vite.config.mjs"),
  ]);
  const [conversationCompactorPage, conversationCompactorCss] = await Promise.all([
    readAppFile("src", "react", "conversation-compactor-page.jsx"),
    readAppFile("src", "react", "conversation-compactor-page.css"),
  ]);

  assert.match(html, /id="app"/u);
  assert.match(html, /src="\.\/main\.jsx"/u);
  assert.match(html, /__SUZU_DEV_INLINE_STYLE__/u);
  assert.doesNotMatch(html, /id="approvalButton"/u);
  assert.doesNotMatch(html, /id="refreshButton"/u);
  assert.doesNotMatch(html, /data-view="actions"/u);
  assert.doesNotMatch(html, /当前联系人/u);

  assert.match(entry, /import "suzu-design-system\/style\.css"/u);
  assert.match(entry, /flushSync\(\(\) => root\.render\(<AppShell \/>\)\)/u);
  assert.match(entry, /import\("\.\/app\.mjs"\)/u);
  assert.match(appShell, /SideNav/u);
  assert.match(appShell, /SideNavItem/u);
  assert.match(appShell, /Input/u);
  assert.match(appShell, /Avatar/u);
  assert.match(appShell, /shell-brand/u);
  assert.doesNotMatch(appShell, /WindowChrome/u);
  assert.match(appShell, /suzu-shell:navigate/u);
  assert.doesNotMatch(appShell, /suzu-shell:command/u);
  assert.match(appShell, /ApplicationRouter/u);
  assert.match(appShell, /renderAppWorkspace/u);
  assert.match(appShell, /setGlobalNotice/u);
  assert.doesNotMatch(app, /suzu-shell:command/u);
  assert.match(shellCss, /shell-brand/u);
  assert.match(shellCss, /-webkit-app-region:drag/u);
  assert.match(shellCss, /-webkit-app-region:no-drag/u);
  assert.match(shellCss, /height:64px/u);

  assert.match(todayPage, /PageHeader/u);
  assert.match(todayPage, /GlassPanel/u);
  assert.match(todayPage, /Calendar/u);
  assert.match(todayPage, /suzu-today:open-conversation/u);
  assert.match(todayPage, /today-conversation-panel/u);
  assert.match(todayPage, /today-conversation-panel__action/u);
  assert.match(todayPage, /aria-label="打开对话"/u);
  assert.match(todayPage, /today-day-panel__actions/u);
  assert.match(todayPage, /today-day-panel__events/u);
  assert.match(todayPage, /data-suzu-today-editor/u);
  assert.doesNotMatch(todayPage, /today-header-actions/u);
  assert.doesNotMatch(todayPage, />开始对话</u);
  assert.match(todayPage, /createPortal/u);
  assert.match(todayCss, /--today-layout-max-width:1480px/u);
  assert.match(todayCss, /margin:0 auto/u);
  assert.match(todayCss, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(todayCss, /grid-template-columns:minmax\(0,\.72fr\) minmax\(0,1\.4fr\)/u);
  assert.match(todayCss, /grid-template-rows:auto minmax\(0,2fr\) minmax\(0,1fr\)/u);
  assert.match(todayCss, /grid-template-rows:minmax\(0,2fr\) minmax\(92px,1fr\)/u);
  assert.doesNotMatch(todayCss, /#content\.content--today\s*\{[^}]*\bbackground:/u);
  assert.match(todayCss, /#content\.content--today > #todayReactRoot \{[\s\S]*flex:1/u);
  assert.match(todayCss, /\.today-insight-card \{[\s\S]*height:100%/u);
  assert.match(todayCss, /#content\.content--today/u);
  assert.match(todayCss, /\.today-day-panel__events \{[\s\S]*overflow-y:auto/u);
  assert.match(todayCss, /body:has\(\[data-suzu-today-editor\]\)/u);
  assert.match(todayCss, /\[role="dialog"\]:has\(\[aria-expanded="true"\]\)/u);
  assert.match(todayCss, /\[role="listbox"\] \{[\s\S]*opacity:1/u);
  assert.doesNotMatch(todayCss, /@container/u);
  assert.doesNotMatch(todayCss, /\.today-glass-workspace,\s*\.today-insight-grid\s*\{\s*grid-template-columns:minmax\(0,1fr\);/u);
  assert.doesNotMatch(todayCss, /minmax\(460px,660px\)/u);
  assert.doesNotMatch(todayCss, /\.today-react-page > \* \{ position:relative; \}/u);
  assert.match(router, /id="todayReactRoot"/u);
  assert.match(app, /suzu-today:open-conversation/u);
  assert.match(app, /content--today/u);

  assert.match(plansPage, /PageHeader/u);
  assert.match(plansPage, /GlassPanel/u);
  assert.match(plansPage, /Empty/u);
  assert.match(plansPage, /scheduleTask/u);
  assert.match(plansPage, /按 Cron 到点执行/u);
  assert.match(plansPage, /PlanEditor/u);
  assert.match(plansPage, /新增计划/u);
  assert.match(plansPage, /选择脚本/u);
  assert.match(plansPage, /已关闭/u);
  assert.match(plansCss, /\.plans-task-card/u);
  assert.match(plansCss, /\.plans-editor-form/u);
  assert.match(router, /<PlansPage/u);
  assert.match(router, /id="plansReactRoot"/u);
  assert.doesNotMatch(app, /unmountPlansPage/u);
  assert.match(preload, /schedule:select-script/u);
  assert.match(preload, /schedule:set-enabled/u);

  assert.match(relationshipsPage, /PageHeader/u);
  assert.match(relationshipsPage, /GlassPanel/u);
  assert.match(relationshipsPage, /openConversation/u);
  assert.match(relationshipsPage, /openCompactor/u);
  assert.match(relationshipsPage, /openMemory/u);
  assert.match(relationshipsPage, /openSettings/u);
  assert.match(relationshipsPage, /ariaLabel="打开对话：查看并继续当前 Claude 会话"/u);
  assert.match(relationshipsPage, /LONG-TERM CONTEXT/u);
  assert.match(relationshipsPage, /renderRelationshipsPage/u);
  assert.match(relationshipsCss, /--relationships-layout-max-width:1200px/u);
  assert.match(relationshipsCss, /relationships-overview/u);
  assert.match(relationshipsCss, /relationships-card--conversation/u);
  assert.match(relationshipsCss, /relationships-card--compactor/u);
  assert.match(router, /<RelationshipsPage/u);
  assert.match(router, /id="relationshipsReactRoot"/u);
  assert.doesNotMatch(app, /unmountRelationshipsPage/u);
  assert.doesNotMatch(app, /renderRelationshipOverview/u);

  assert.match(conversationCompactorPage, /PageHeader/u);
  assert.match(conversationCompactorPage, /这位联系人的摘要提示词/u);
  assert.match(conversationCompactorPage, /自动压缩/u);
  assert.match(conversationCompactorPage, /手动压缩/u);
  assert.match(conversationCompactorPage, /每天固定时间/u);
  assert.match(conversationCompactorPage, /达到 Token 阈值/u);
  assert.match(conversationCompactorPage, /保留最近 Token/u);
  assert.match(conversationCompactorPage, /立即压缩/u);
  assert.doesNotMatch(conversationCompactorPage, /检查是否需要压缩/u);
  assert.match(conversationCompactorPage, /CONTACTS/u);
  assert.match(conversationCompactorPage, /还没有聊天记录/u);
  assert.match(conversationCompactorPage, /contactId: contact.id/u);
  assert.match(conversationCompactorCss, /--conversation-compactor-layout-min-width:920px/u);
  assert.doesNotMatch(conversationCompactorCss, /@media \(max-width/u);
  assert.match(router, /<ConversationCompactorPage/u);
  assert.match(router, /id="conversationCompactorReactRoot"/u);
  assert.match(app, /conversationCompactor/u);
  assert.match(app, /openCompactor/u);
  assert.match(preload, /conversation-compactor:run/u);

  assert.match(relationshipSettingsPage, /PageHeader/u);
  assert.match(relationshipSettingsPage, /Roster/u);
  assert.match(relationshipSettingsPage, /Tabs/u);
  assert.match(relationshipSettingsPage, /saveFile/u);
  assert.match(relationshipSettingsPage, /createFile/u);
  assert.match(relationshipSettingsPage, /selectContact/u);
  assert.match(relationshipSettingsCss, /container-type:inline-size/u);
  assert.match(relationshipSettingsCss, /@container \(max-width:1140px\)/u);
  assert.match(relationshipSettingsCss, /relationship-settings-contact-rail \{ display:none;/u);
  assert.doesNotMatch(relationshipSettingsCss, /grid-auto-flow:column/u);
  assert.match(relationshipSettingsCss, /background:var\(--panel\)/u);
  assert.match(router, /<RelationshipSettingsPage/u);
  assert.match(router, /id="relationshipSettingsReactRoot"/u);
  assert.doesNotMatch(app, /unmountRelationshipSettingsPage/u);
  assert.doesNotMatch(app, /renderRelationshipSettings\(/u);
  assert.doesNotMatch(app, /bindRelationshipSettingsEvents/u);

  assert.match(conversationPage, /conversation-workspace/u);
  assert.match(conversationPage, /actions\.selectContact/u);
  assert.match(conversationPage, /actions\.submitMessage/u);
  assert.match(conversationPage, /conversation-composer__surface/u);
  assert.match(conversationPage, /actions\.toggleEmoji/u);
  assert.match(conversationPage, /actions\.openSessionSettings/u);
  assert.match(conversationPage, /actions\.runSearch/u);
  assert.match(conversationPage, /actions\.uploadContactAvatar/u);
  assert.match(conversationPage, /conversation-send-button/u);
  assert.match(conversationPage, /ChatVoice/u);
  assert.match(conversationPage, /<audio/u);
  assert.doesNotMatch(conversationPage, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(conversationPage, /data-toggle-conversation-emoji/u);
  assert.doesNotMatch(conversationPage, /data-conversation-contact/u);
  assert.doesNotMatch(conversationPage, /ChatBubble/u);
  assert.match(conversationPageCss, /#conversationReactRoot/u);
  assert.match(conversationPageCss, /height:100%/u);
  assert.match(conversationCss, /conversation-message\.user \.conversation-bubble[\s\S]*background:\s*#95ec69/u);
  assert.match(app, /conversationReactSnapshot/u);
  assert.match(app, /createConversationReactActions/u);
  assert.doesNotMatch(app, /bindConversationEvents/u);
  assert.match(router, /<ConversationPage/u);
  assert.match(router, /id="conversationReactRoot"/u);
  assert.match(router, /<OnboardingDialog/u);
  assert.doesNotMatch(router, /onboardingMarkup/u);
  assert.doesNotMatch(app, /unmountConversationPage/u);
  assert.doesNotMatch(app, /renderConversation\(/u);

  assert.match(createPage, /PageHeader/u);
  assert.match(createPage, /Status/u);
  assert.match(createPage, /CREATE_SPACES/u);
  assert.match(createPage, /openVisual/u);
  assert.match(createPage, /openAudio/u);
  assert.match(createPage, /renderCreatePage/u);
  assert.match(router, /id="createReactRoot"/u);
  assert.match(router, /<CreatePage/u);
  assert.doesNotMatch(app, /unmountCreatePage/u);
  assert.doesNotMatch(app, /renderCreateOverview\(/u);
  assert.doesNotMatch(app, /bindCreateOverviewEvents/u);

  assert.match(createVisualPage, /PageHeader/u);
  assert.match(createVisualPage, /CreateStudioDialog/u);
  assert.match(createVisualPage, /api\.imageWorkbench\.generate/u);
  assert.match(createVisualPage, /api\.visualReferences\.snapshot/u);
  assert.match(createVisualPage, /renderCreateVisualPage/u);
  assert.match(createAudioPage, /PageHeader/u);
  assert.match(createAudioPage, /CreateStudioDialog/u);
  assert.match(createAudioPage, /api\.voiceDesign\.snapshot/u);
  assert.match(createAudioPage, /api\.voiceDesign\.saveContactVoice/u);
  assert.match(createAudioPage, /renderCreateAudioPage/u);
  assert.match(createCss, /min-width:\s*920px/u);
  assert.match(createCss, /create-react-dialog-backdrop/u);
  assert.match(router, /id="createVisualReactRoot"/u);
  assert.match(router, /id="createAudioReactRoot"/u);
  assert.match(router, /<CreateVisualPage/u);
  assert.match(router, /<CreateAudioPage/u);
  assert.doesNotMatch(app, /unmountCreateVisualPage/u);
  assert.doesNotMatch(app, /unmountCreateAudioPage/u);
  assert.doesNotMatch(app, /features\/create\/drawing/u);
  assert.doesNotMatch(app, /features\/create\/audio/u);

  assert.match(capabilitiesPage, /PageHeader/u);
  assert.match(capabilitiesPage, /GlassPanel/u);
  assert.match(capabilitiesPage, /capabilityOverview/u);
  assert.match(capabilitiesPage, /openCategory/u);
  assert.match(capabilitiesPage, /openExternal/u);
  assert.match(capabilitiesPage, /renderCapabilitiesPage/u);
  assert.match(capabilityDetailPage, /CapabilityCategoryPage/u);
  assert.match(capabilityDetailPage, /CapabilityDetailPage/u);
  assert.match(capabilityDetailPage, /ExternalCapabilitiesPage/u);
  assert.match(capabilityDetailPage, /WechatSettings/u);
  assert.match(capabilityDetailPage, /SiteAutomationSiteSettings/u);
  assert.match(capabilitiesCss, /--capabilities-layout-min-width:920px/u);
  assert.match(capabilitiesCss, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.doesNotMatch(capabilitiesCss, /@media \(max-width/u);
  assert.match(router, /id="capabilitiesReactRoot"/u);
  assert.match(router, /<CapabilitiesPage/u);
  assert.doesNotMatch(app, /unmountCapabilitiesPage/u);
  assert.match(app, /saveCapabilitySettings/u);
  assert.match(app, /saveWechatSettings/u);
  assert.match(app, /importExternalCapability/u);
  assert.doesNotMatch(app, /renderCapabilities\(context\)/u);
  assert.match(app, /routeForCurrentView/u);
  assert.match(app, /renderAppWorkspace\(workspace\)/u);
  assert.doesNotMatch(app, /content\.innerHTML/u);

  assert.match(main, /titleBarStyle:\s*"hidden"/u);
  assert.match(main, /titleBarOverlay/u);
  assert.match(main, /webSecurity:\s*false/u);
  assert.doesNotMatch(main, /sandbox:\s*true/u);
  assert.match(main, /WINDOW_CHROME_HEIGHT = 64/u);
  assert.match(main, /minWidth:\s*1080/u);
  assert.match(preload, /windowChrome:\s*\{/u);
  assert.match(viteConfig, /suzu-development-style-csp/u);
  assert.match(viteConfig, /context\.server/u);
});
