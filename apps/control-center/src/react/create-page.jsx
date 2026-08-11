import { createRoot } from "react-dom/client";
import { PageHeader, Status } from "suzu-design-system";

import { CREATE_SPACES } from "../features/create/overview.mjs";

function CreateSpaceCard({ onOpen, space }) {
  return (
    <button aria-label={`进入${space.title}`} className="create-space-card" onClick={onOpen} type="button">
      <div className="create-space-card-top">
        <span aria-hidden="true" className="create-space-symbol">{space.symbol}</span>
        <Status label={space.label} tone="success" />
      </div>
      <div>
        <h2>{space.title}</h2>
        <p>{space.detail}</p>
      </div>
      <span className="create-space-enter">进入</span>
    </button>
  );
}

export function CreatePage({ actions = {} }) {
  return (
    <>
      <PageHeader eyebrow="CREATE" subtitle="把视觉灵感与声音方向整理成可以继续推进的创作现场。" title="创作" />
      <section aria-label="创作空间" className="create-space-grid">
        {CREATE_SPACES.map((space) => (
          <CreateSpaceCard
            key={space.id}
            onOpen={space.id === "visual" ? actions.openVisual : actions.openAudio}
            space={space}
          />
        ))}
      </section>
    </>
  );
}

let pageElement = null;
let pageRoot = null;

export function renderCreatePage(element, props) {
  if (!element) return;
  if (pageElement !== element) {
    pageRoot?.unmount();
    pageElement = element;
    pageRoot = createRoot(element);
  }
  pageRoot.render(<CreatePage {...props} />);
}

export function unmountCreatePage() {
  pageRoot?.unmount();
  pageRoot = null;
  pageElement = null;
}
