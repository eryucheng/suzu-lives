import { GlassPanel, PageHeader, Status } from "suzu-design-system";

import { PageScaffold } from "./page-scaffold.jsx";
import "./relationships-page.css";

function RelationshipCard({ ariaLabel, children, className = "", onOpen }) {
  return (
    <GlassPanel as="article" className={`relationships-card ${className}`.trim()} intensity="soft">
      <button aria-label={ariaLabel} className="relationships-card__action" onClick={onOpen} type="button">
        {children}
      </button>
    </GlassPanel>
  );
}

export function RelationshipsPage({ actions = {}, snapshot = {} }) {
  const memory = snapshot.memory || {};
  const memoryReady = memory.status === "ready";

  return (
    <PageScaffold
      className="relationships-react-page"
      header={<PageHeader eyebrow="RELATIONSHIPS" subtitle="在这里查看对话、记忆与重要关系。" title="关系" />}
    >
      <section aria-label="关系功能" className="relationships-overview">
        <RelationshipCard
          ariaLabel="打开对话：查看并继续当前会话"
          className="relationships-card--conversation"
          onOpen={actions.openConversation}
        >
          <div className="relationships-card__topline">
            <span className="relationships-card__eyebrow">CONVERSATION</span>
          </div>
          <div className="relationships-card__conversation-copy">
            <h2>对话</h2>
            <p>按联系人查看会话</p>
          </div>
        </RelationshipCard>

        <RelationshipCard
          ariaLabel="打开记忆压缩器：按会话整理上下文"
          className="relationships-card--compactor"
          onOpen={actions.openCompactor}
        >
          <div className="relationships-card__secondary-head">
            <div><span className="relationships-card__eyebrow">CONTEXT COMPACTION</span><h2>记忆压缩器</h2></div>
          </div>
          <p className="relationships-card__description">按会话整理上下文</p>
        </RelationshipCard>

        <RelationshipCard
          ariaLabel="打开记忆：查看、检索和维护长期记忆"
          className="relationships-card--memory"
          onOpen={actions.openMemory}
        >
          <div className="relationships-card__secondary-head">
            <div><span className="relationships-card__eyebrow">LONG-TERM CONTEXT</span><h2>记忆</h2></div>
            <Status label={memoryReady ? "可用" : "尚未建立"} tone={memoryReady ? "success" : "warning"} />
          </div>
          <p className="relationships-card__description">可追溯的长期上下文</p>
        </RelationshipCard>

        <RelationshipCard
          ariaLabel="打开相处设定：编辑当前项目中的关系文本"
          className="relationships-card--settings"
          onOpen={actions.openSettings}
        >
          <div className="relationships-card__secondary-head">
            <div><span className="relationships-card__eyebrow">RELATIONSHIP SETUP</span><h2>相处设定</h2></div>
          </div>
          <p className="relationships-card__description">管理 SUZU.md、persona.md、user.md 与引用的 Markdown 文件。</p>
        </RelationshipCard>

        <RelationshipCard
          ariaLabel="查看日记：按联系人浏览 Agent 写下的每日回顾"
          className="relationships-card--journal"
          onOpen={actions.openJournal}
        >
          <div className="relationships-card__secondary-head">
            <div><span className="relationships-card__eyebrow">AGENT JOURNAL</span><h2>查看日记</h2></div>
          </div>
          <p className="relationships-card__description">按联系人浏览 Agent 写下的每日回顾。</p>
        </RelationshipCard>
      </section>
    </PageScaffold>
  );
}
