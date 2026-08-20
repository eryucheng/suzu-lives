# Suzu Agent Core — upstream source notices

This directory is Suzu's generated execution kernel. It contains only the
compiled, selected runtime modules that Suzu uses, plus the few Windows native
helpers that cannot be compiled into JavaScript. It is not an embedded
DeepSeek Harness application or a copied `node_modules` tree.

The module-to-source audit is in `MANIFEST.json`; the complete third-party
license record is in `THIRD_PARTY_NOTICES.md`. The selected upstream source
snapshot is DeepSeek Harness `0.1.0-rc.6`, obtained from its published npm
packages and used under their respective licenses.

Suzu owns the process host, IPC control plane, lifecycle hooks, profiles,
settings integration, conversation rendering, storage policy and product
features. No upstream desktop UI, CLI, web server, workflow, workspace,
subagent or code-mode product bundle is present here.
