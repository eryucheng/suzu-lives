# Capability registry

This package is the software-owned capability catalog. It exposes stable IDs, migration state, dependency types, configuration requirements, true enablement state, and Claude-registration eligibility.

It does not infer a configured external service from a package being present. It stores only per-ability-whitelisted non-secret configuration in the software data root, requires a deliberate enable action, and rejects `invoke` before dispatch when enablement or configuration is missing. Actual invocation consumes a short-lived, single-use software-signed credential bound to the ability, action, and scope; the stable CLI cannot issue one. Package executors perform their own concrete dependency and private authorization-context checks; `plan` is a separate, explicitly non-executing mode.

## Internal capability CLI

The `./internal-cli` export is the host-neutral contract for Suzu-owned, Agent-callable capabilities. Its canonical shell form is:

```text
suzu-lives capability <capability-id> <action> --input-json '<JSON>'
```

Only the shared outer options `--input-json`, `--data-root`, and `--workspace-root` are accepted. Every call writes one JSON envelope to stdout:

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "capabilityId": "…",
  "action": "…",
  "result": {}
}
```

Failures use the same envelope with `status: "error"` and `error: { "code", "message" }`. The core accepts a host-supplied runtime context (`dataRoot`, `agentId`, `ledgerPath`, optional resolved connection), so Claude Code, Hermes, or another future Agent adapter can share the same command/input/output contract without inheriting a Claude-specific project model.
