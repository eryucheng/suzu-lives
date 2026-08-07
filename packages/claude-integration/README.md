# Claude integration

This package writes and updates only lightweight, marked Claude registration files after the user explicitly selects a project and confirms the registration action.

Generated `CLAUDE.md` content and `.claude/skills/<ability>/SKILL.md` files contain a stable `suzu-lives` command contract. Most current ability invocations require a short-lived, single-use credential issued by the software control plane; the CLI and generated skill cannot issue one. Direct compatibility registrations remain separate from capability-registry: media abilities use their software-owned runtime, while `proactive-contact` and `traveling-merchant` use Suzu's own `schedule` runtime and data root.

Registration writes Suzu-owned defaults into the selected project's `.claude/settings.json`: `skipWebFetchPreflight: true`, the current packaged Suzu CLI permission, and `Bash(playwright-cli *)`. It also writes the globally selected defaults for `Read`, `WebFetch`, and `WebSearch`; all three are enabled in a new installation. Existing user settings, Hooks, and unrelated permission rules remain unchanged. When the packaged EXE changes, only the prior Suzu CLI permission is replaced with the current executable path.

Registration files never contain Suzu Lives source code, absolute installation paths, configuration, cache paths, user data, credentials, or development-specific references. The registration API refuses to overwrite an unmarked user skill file, rejects symlinked registration paths, and rolls back the paired files if either transaction commit fails.
