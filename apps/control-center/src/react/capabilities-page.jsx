import { Empty, GlassPanel, PageHeader, Status } from "suzu-design-system";

import { capabilityCategory, capabilityOverview, createWechatConnectionCapability } from "../features/capabilities/overview.mjs";
import { CapabilityCategoryPage, CapabilityDetailPage, ExternalCapabilitiesPage } from "./capability-detail-page.jsx";
import { PageScaffold } from "./page-scaffold.jsx";

import "./capabilities-page.css";

const CATEGORY_SYMBOLS = Object.freeze({
  act: "↗",
  companion: "✦",
  create: "◌",
  perceive: "◈",
});

function categoryMembers(capabilities, categoryId) {
  return capabilities.filter((capability) => capabilityCategory(capability) === categoryId);
}

function enabledCapabilityNames(capabilities) {
  return capabilities.filter((capability) => capability.enabled === true).map((capability) => capability.name);
}

function CapabilityCategoryCard({ category, members, onOpen }) {
  const enabled = enabledCapabilityNames(members);
  const tone = enabled.length ? "success" : "muted";
  const className = ["capability-overview-card", "capability-overview-card--" + category.id].join(" ");

  return (
    <GlassPanel as="article" className={className} intensity="soft">
      <button
        aria-label={"打开" + category.label + "能力"}
        className="capability-overview-card__action"
        onClick={onOpen}
        type="button"
      >
        <div className="capability-overview-card__top">
          <span aria-hidden="true" className="capability-overview-card__symbol">{CATEGORY_SYMBOLS[category.id] || "◌"}</span>
          <Status label={enabled.length + " / " + members.length + " 已开启"} tone={tone} />
        </div>

        <div className="capability-overview-card__copy">
          <span className="capability-overview-card__eyebrow">{category.id.toUpperCase()}</span>
          <h2>{category.label}</h2>
          <p>{category.detail}</p>
        </div>
      </button>
    </GlassPanel>
  );
}

function ExternalCapabilityCard({ count, onOpen }) {
  return (
    <GlassPanel as="article" className="capabilities-external-card" intensity="soft">
      <button aria-label="打开外部能力" className="capabilities-external-card__action" onClick={onOpen} type="button">
        <div className="capabilities-external-card__symbol" aria-hidden="true">＋</div>
        <div className="capabilities-external-card__copy">
          <span>EXTERNAL CAPABILITIES</span>
          <h2>外部能力</h2>
          <p>{count ? "已导入 " + count + " 项本地能力，可查看状态并登记到项目。" : "导入本地 suzu-capability.json，接入 Skill 或 MCP。"}</p>
        </div>
        <Status label={count ? "已导入 " + count + " 项" : "可导入"} tone={count ? "success" : "muted"} />
      </button>
    </GlassPanel>
  );
}

function CapabilitiesOverview({ actions, overview, snapshot }) {
  const externalCount = Array.isArray(snapshot.externalCapabilities?.capabilities)
    ? snapshot.externalCapabilities.capabilities.length
    : 0;

  return (
    <PageScaffold
      className="capabilities-react-page"
      header={<PageHeader eyebrow="CAPABILITIES" subtitle="整理感知、陪伴、行动与创作。" title="能力" />}
    >
      <section aria-label="能力方向" className="capabilities-overview-grid">
        {overview.categories.map((category) => (
          <CapabilityCategoryCard
            category={category}
            key={category.id}
            members={categoryMembers(overview.capabilities, category.id)}
            onOpen={() => actions.openCategory?.(category.id)}
          />
        ))}
        <ExternalCapabilityCard count={externalCount} onOpen={actions.openExternal} />
      </section>
    </PageScaffold>
  );
}

export function CapabilitiesPage({ actions = {}, snapshot = {} }) {
  const capabilitySnapshot = snapshot.capabilitySnapshot;
  if (!capabilitySnapshot) {
    return (
      <PageScaffold
        className="capabilities-react-page"
        header={<PageHeader eyebrow="CAPABILITIES" subtitle="整理感知、陪伴、行动与创作。" title="能力" />}
      >
        <Empty className="capabilities-empty" description="正在读取可用能力与已保存设置。" title="正在读取能力" />
      </PageScaffold>
    );
  }

  const overview = capabilityOverview({
    capabilitySnapshot,
    wechatSnapshot: snapshot.wechatSnapshot,
  });
  const route = snapshot.page || "overview";
  const categoryId = overview.categories.some((category) => category.id === snapshot.categoryId)
    ? snapshot.categoryId
    : overview.categories[0]?.id || "act";

  if (route === "external") {
    return <ExternalCapabilitiesPage actions={actions} externalSnapshot={snapshot.externalCapabilities} />;
  }
  if (route === "category") {
    return <CapabilityCategoryPage actions={actions} capabilitySnapshot={capabilitySnapshot} categoryId={categoryId} wechatSnapshot={snapshot.wechatSnapshot} />;
  }
  if (route === "detail") {
    const capability = overview.capabilities.find((item) => item.id === snapshot.selectedId && capabilityCategory(item) === categoryId)
      || overview.capabilities.find((item) => item.id === snapshot.selectedId)
      || overview.capabilities.find((item) => capabilityCategory(item) === categoryId)
      || createWechatConnectionCapability(snapshot.wechatSnapshot);
    return (
      <CapabilityDetailPage
        actions={actions}
        apiServices={snapshot.apiServices}
        capability={capability}
        categoryId={capabilityCategory(capability)}
        contactsSnapshot={snapshot.contactsSnapshot}
        wechatSnapshot={snapshot.wechatSnapshot}
      />
    );
  }
  return <CapabilitiesOverview actions={actions} overview={overview} snapshot={snapshot} />;
}
