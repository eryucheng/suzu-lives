import { Empty, GlassPanel, PageHeader } from "suzu-design-system";

import "./chat-first-unavailable-page.css";

export function ChatFirstUnavailablePage({ description = "这个功能暂未接入当前聊天优先版本。", title = "暂未接入" }) {
  return (
    <div className="chat-first-unavailable-page">
      <PageHeader eyebrow="COMING LATER" subtitle="旧功能和已有资料都保留在本地；这里只暂时不开放入口。" title={title} />
      <GlassPanel as="section" className="chat-first-unavailable-panel" intensity="soft">
        <Empty description={description} title="暂未接入" />
      </GlassPanel>
    </div>
  );
}
