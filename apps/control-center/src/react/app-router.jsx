import { AdminPage } from "./admin-page.jsx";
import { CapabilitiesPage } from "./capabilities-page.jsx";
import { ConversationCompactorPage } from "./conversation-compactor-page.jsx";
import { ConversationPage } from "./conversation-page.jsx";
import { CreateAudioPage } from "./create-audio-page.jsx";
import { CreatePage } from "./create-page.jsx";
import { CreateVisualPage } from "./create-visual-page.jsx";
import { MemoryPage } from "./memory-page.jsx";
import { PlansPage } from "./plans-page.jsx";
import { RelationshipsPage } from "./relationships-page.jsx";
import { RelationshipSettingsPage } from "./relationship-settings-page.jsx";
import { SettingsPage } from "./settings-page.jsx";
import { TodayPage } from "./today-page.jsx";
import { OnboardingDialog } from "./onboarding-dialog.jsx";

function RouteContent({ route }) {
  const props = route?.props || {};
  switch (route?.kind) {
    case "today":
      return <div id="todayReactRoot"><TodayPage {...props} /></div>;
    case "create":
      return <div id="createReactRoot"><CreatePage {...props} /></div>;
    case "create-visual":
      return <div id="createVisualReactRoot"><CreateVisualPage {...props} /></div>;
    case "create-audio":
      return <div id="createAudioReactRoot"><CreateAudioPage {...props} /></div>;
    case "capabilities":
      return <div id="capabilitiesReactRoot"><CapabilitiesPage {...props} /></div>;
    case "settings":
      return <div id="settingsReactRoot"><SettingsPage {...props} /></div>;
    case "plans":
      return <div id="plansReactRoot"><PlansPage {...props} /></div>;
    case "admin":
      return <div id="adminReactRoot"><AdminPage {...props} /></div>;
    case "relationships":
      return <div id="relationshipsReactRoot"><RelationshipsPage {...props} /></div>;
    case "relationship-settings":
      return <div id="relationshipSettingsReactRoot"><RelationshipSettingsPage {...props} /></div>;
    case "conversation":
      return <div id="conversationReactRoot"><ConversationPage {...props} /></div>;
    case "conversation-compactor":
      return <div id="conversationCompactorReactRoot"><ConversationCompactorPage {...props} /></div>;
    case "memory":
      return <div id="memoryReactRoot"><MemoryPage {...props} /></div>;
    default:
      return null;
  }
}

export function ApplicationRouter({ workspace = null }) {
  if (!workspace) return null;
  return (
    <>
      <RouteContent route={workspace.route} />
      <OnboardingDialog onboarding={workspace.onboarding} />
    </>
  );
}
