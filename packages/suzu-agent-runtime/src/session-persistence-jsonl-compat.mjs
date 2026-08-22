import { basename } from "node:path";

import { JsonlSessionPersistence as UpstreamJsonlSessionPersistence } from "../vendor/core/modules/session-persistence-jsonl.mjs";

function isRawSessionArtifact(value) {
  return basename(String(value ?? "")) === "session.jsonl";
}

/**
 * Core persists sessions as zstd.  The product also keeps the contact's raw
 * JSONL event chain for chat rendering.  Upstream treats the two formats in
 * one directory as mutually exclusive and rejects the whole session before
 * the reader can project its events.
 *
 * When Core is scanning its own zstd artifact, hide the JSONL render artifact
 * from that scan only. Neither file is converted, rewritten, moved, deleted,
 * or used as a fallback for the other.
 */
export class SuzuJsonlSessionPersistence extends UpstreamJsonlSessionPersistence {
  async exists(location) {
    if (this.compression === "zstd" && isRawSessionArtifact(location)) {
      const compressedSession = `${location}.zstd`;
      if (await super.exists(compressedSession)) return false;
    }
    return super.exists(location);
  }
}

export default SuzuJsonlSessionPersistence;
