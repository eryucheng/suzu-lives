import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Python workers cannot execute from Electron's app.asar archive.  When the
 * builder has unpacked an asset, choose its adjacent app.asar.unpacked copy;
 * source and non-packaged test runs keep their original path.
 */
export function resolveUnpackedRuntimeAssetPath(sourcePath, { exists = existsSync } = {}) {
  const source = String(sourcePath || "");
  const marker = `${path.sep}app.asar${path.sep}`;
  const index = source.indexOf(marker);
  if (index === -1) return source;
  const unpacked = `${source.slice(0, index)}${path.sep}app.asar.unpacked${path.sep}${source.slice(index + marker.length)}`;
  return exists(unpacked) ? unpacked : source;
}
