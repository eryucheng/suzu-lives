import { PageHeader, Status } from "suzu-design-system";

import { CREATE_SPACES } from "../features/create/overview.mjs";
import { PageScaffold } from "./page-scaffold.jsx";

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
    <PageScaffold
      className="create-react-page"
      header={<PageHeader eyebrow="CREATE" subtitle="把视觉灵感、参考资料与候选结果整理成可以继续推进的创作现场。" title="创造" />}
    >
      <section aria-label="创作空间" className="create-space-grid">
        {CREATE_SPACES.map((space) => (
          <CreateSpaceCard
            key={space.id}
            onOpen={actions.openVisual}
            space={space}
          />
        ))}
      </section>
    </PageScaffold>
  );
}
