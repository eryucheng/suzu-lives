# Internal capability CLI

This package owns the host-neutral command contract for Suzu-owned, Agent-callable capabilities. It does not maintain a second generic registry, enablement store, or invocation path: desktop capability settings and Claude registrations are managed by the control center.

The `./internal-cli` export provides the canonical shell form:

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
