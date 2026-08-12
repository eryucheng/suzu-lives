# Claude integration

This package writes and updates only lightweight, marked Claude registration files after the user explicitly selects a project and confirms the registration action.

Generated `CLAUDE.md` content and `.claude/skills/<ability>/SKILL.md` files contain a stable `suzu-lives` command contract. Each generated skill points directly to the current software-owned command: Agent-callable media abilities use `capability <id> <action> --input-json`, while browser, iPhone and scheduled abilities use their dedicated commands and data roots. Skills never route through a second generic invocation layer.

Registration writes Suzu-owned defaults into the selected project's `.claude/settings.json`: `skipWebFetchPreflight: true`, the current Suzu CLI permission, and `Bash(playwright-cli *)`. It also writes the globally selected defaults for `Read`, `WebFetch`, and `WebSearch`; all three are enabled in a new installation. Existing user settings, Hooks, and unrelated permission rules remain unchanged. A packaged app registers its current EXE; a development checkout registers the running Electron executable plus its app root, so generated Skills never silently call a stale installed build. When that launcher changes, only the prior Suzu CLI permission is replaced.

Registration files never contain configuration, cache paths, user data, credentials, or capability source code. In development they intentionally contain the current source checkout launcher so the generated Skill executes the same code the developer is testing; packaged releases contain their current EXE launcher. The registration API refuses to overwrite an unmarked user skill file, rejects symlinked registration paths, and rolls back the paired files if either transaction commit fails.
