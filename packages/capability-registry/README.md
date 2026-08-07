# Capability registry

This package is the software-owned capability catalog. It exposes stable IDs, migration state, dependency types, configuration requirements, true enablement state, and Claude-registration eligibility.

It does not infer a configured external service from a package being present. It stores only per-ability-whitelisted non-secret configuration in the software data root, requires a deliberate enable action, and rejects `invoke` before dispatch when enablement or configuration is missing. Actual invocation consumes a short-lived, single-use software-signed credential bound to the ability, action, and scope; the stable CLI cannot issue one. Package executors perform their own concrete dependency and private authorization-context checks; `plan` is a separate, explicitly non-executing mode.
