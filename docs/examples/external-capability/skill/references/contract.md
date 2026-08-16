# Local weather core contract

The core capability owns weather retrieval, validation, caching, and error
semantics. CLI, Skill, and MCP adapters should remain thin callers of that
single core implementation.
