// Kept as the package's stable entry point while the implementation is now
// Suzu's private Node IPC Agent Core rather than an external Web host.
export {
  createSuzuAgentCoreSupervisor,
  resolveEmbeddedSuzuAgentHost,
  resolveEmbeddedSuzuAgentModuleLoader,
} from "./supervisor-core.mjs";
