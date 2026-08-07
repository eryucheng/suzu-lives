---
name: local-weather-example
description: Explain when to call the local-weather core capability.
---

Use the local-weather CLI or MCP adapter only when the user explicitly asks for
local weather data. Both adapters must delegate to the same capability core;
do not duplicate the weather business logic in this Skill.

The files under `scripts/`, `references/`, and `assets/` are package resources.
Suzu Lives copies them to the current host project's managed Skill directory,
but never executes them during import, diagnosis, installation, update, or
removal.
