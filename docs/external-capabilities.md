# 外部能力清单（V1）

Suzu Lives 的外部能力清单是 Agent 中立的本地描述文件。它描述一个能力有哪些适配器，不假定 Claude Code、`.claude`、`CLAUDE.md` 或任何其他宿主专属字段。

当前 Suzu Lives 只提供 **Claude Code 项目安装器**：它把已导入的中立清单保守地登记到当前联系人对应的 Claude 项目。未来可以在不改变清单格式的前提下增加其他 Agent runtime 的安装器。

## 文件与导入范围

建议将清单命名为 `suzu-capability.json`，并在“能力 → 外部能力”中通过本地文件选择器导入。V1 只读取用户明确选择的本地清单及其本地包文件：不会下载依赖、不会启动 CLI、不会启动 MCP server，也不会联网探测。

导入后，Suzu Lives 会保留一份审计副本：

```text
<Suzu 数据目录>/external-capabilities/registry.json
<Suzu 数据目录>/external-capabilities/manifests/<capability-id>/suzu-capability.json
```

原始清单或 Skill 源文件/目录后来丢失时，页面会显示静态诊断。原始清单丢失不影响审计副本；Skill 包或本地 MCP 文件丢失时不能新启用或更新登记。

## V1 清单格式

```json
{
  "schemaVersion": 1,
  "id": "example.local-weather",
  "name": "本地天气",
  "version": "1.0.0",
  "description": "可选，最多 2000 个字符。",
  "adapters": {
    "skill": {
      "directory": "skill"
    },
    "mcp": {
      "transport": "stdio",
      "command": "node",
      "args": ["./server.mjs"],
      "env": {
        "WEATHER_CACHE": "${WEATHER_CACHE_DIR:-./cache}"
      }
    },
    "cli": {
      "command": "local-weather",
      "args": ["--json"]
    }
  }
}
```

必填字段如下：

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必须为数字 `1`。 |
| `id` | 1–64 个小写字母、数字、点、短横线或下划线；不能以符号结尾。ID 是更新和受管登记的稳定键。 |
| `name` | 1–120 个字符。 |
| `version` | SemVer，例如 `1.0.0`。 |
| `adapters` | 至少包含 `skill` 或 `mcp` 之一；未知字段会被拒绝。 |

`description` 可选。V1 严格拒绝未知字段，以免作者误以为未实现的配置已生效；未来扩展会使用新的 `schemaVersion`。

### `skill` 适配器

`skill` 必须且只能使用下面一种写法：

```json
"skill": { "directory": "skill" }
```

```json
"skill": { "file": "SKILL.md" }
```

推荐 `directory`。它指向能力包内的一个真实目录，目录根必须有 `SKILL.md`，并且可包含 `scripts/`、`references/`、`assets/`、模板和其他普通文件。例如：

```text
skill/
├─ SKILL.md
├─ scripts/
│  └─ format-result.mjs
├─ references/
│  └─ contract.md
└─ assets/
   └─ icon.bin
```

`file` 是兼容既有单文件 Skill 的写法；安装时它会成为受管目录中的 `SKILL.md`。两种路径都必须是能力包内使用 `/` 的相对路径，不能使用绝对路径、反斜杠或 `..`。

导入/启用会递归读取目录型 Skill，但只接受真实目录和普通文件：符号链接、特殊文件、路径逃逸、超过 16 层目录、超过 256 个文件、单文件超过 1 MB 或总计超过 8 MB 都会被拒绝。普通文件按原始字节复制，所以资源文件不被转码；根目录 `SKILL.md` 必须是非空 UTF-8 文本。Suzu Lives 不会执行包内脚本、不会运行 CLI 或 MCP、不会下载依赖，也不会联网探测。

Skill 内容可以采用 Claude-compatible frontmatter，但清单和包结构本身仍保持 Agent 中立；能否被某个宿主使用取决于对应安装器。

### `mcp` 适配器

V1 支持本地 stdio 与 HTTPS（或本机回环 HTTP）两种描述：

```json
{
  "transport": "stdio",
  "command": "node",
  "args": ["./server.mjs"],
  "env": { "CACHE_DIR": "${CACHE_DIR}" }
}
```

```json
{
  "transport": "http",
  "url": "https://example.test/mcp",
  "headers": { "X-Client": "suzu-lives" }
}
```

stdio 的 `command` 和 `args` 中以 `./` 开头的本地文件路径会在安装时解析为能力包的绝对路径，避免它们被错误地按项目工作目录解析。Suzu Lives 不检查 PATH、不运行命令、不连接 HTTP endpoint。不要把 API key、token 或密码写进清单；请使用宿主支持的环境变量展开（例如 `${API_KEY}`）或由能力自己的安全配置流程提供凭据。

### `cli` 适配器（已预留，不执行）

```json
"cli": {
  "command": "local-weather",
  "args": ["--json"]
}
```

CLI 是一等清单字段，方便未来的自动化和其他宿主使用。但 V1 不会探测、注册、执行或下载任何第三方 CLI；因此只声明 `cli` 的清单会被拒绝，仍需同时提供 `skill` 或 `mcp`。

推荐作者采用一套核心实现，避免把业务逻辑复制到多个适配器：

```text
核心能力实现
├─ 稳定 CLI（自动化入口）
├─ Skill（说明何时、如何调用核心/CLI）
└─ MCP（将工具请求薄适配到同一核心）
```

Skill 与 MCP 应是薄适配层；不要在三处各自实现能力逻辑、状态格式或权限规则。

## 当前 Claude Code 安装器

在用户点击“启用并登记到当前联系人”后，当前安装器仅写入所选联系人项目：

| 适配器 | 写入位置 | 受管方式 |
| --- | --- | --- |
| Skill | `.claude/skills/suzu-external-<id>/` 下的完整包树 | 同目录的 Suzu 所有权记录保存“受管相对路径 → 内容哈希”；只写入或删除哈希仍匹配的文件。 |
| MCP | 项目根目录 `.mcp.json` 的 `mcpServers.suzu-external-<id>` | `.claude/suzu-lives-external-capabilities.json` 只记录 Suzu 自己条目的哈希。 |

安装器不会写清单专属的 Claude 字段，也不会修改 `CLAUDE.md`。它保留已有 `.mcp.json` 的其他键和其他 `mcpServers` 条目。若同名文件/条目不是 Suzu 自己标记的，或已登记内容被手动修改，操作会失败并保留用户文件。目录型 Skill 的用户后来添加文件不属于受管清单，不会在更新、停用或移除时被删除；若新包试图覆盖这样的同名用户文件，操作会失败。

“已登记”只表示项目配置或 Skill 文件已安全写入；不表示 MCP 已连接、CLI 已运行或能力已成功执行。Claude Code 对项目 MCP 的加载、批准和实际运行仍遵循它自己的流程与权限提示。详见 [Claude Code 的 MCP 项目配置文档](https://code.claude.com/docs/en/mcp)。

## 更新、停用与移除

- 再次导入相同 `id` 会更新已保存清单；当前项目如果仍是旧版本，页面会提示再次启用更新受管登记。
- 更新目录型 Skill 时，只会删除新包不再提供、且内容哈希仍匹配的旧受管文件；不会删除用户后来加到受管目录里的文件。停用和移除使用同一规则。
- 早期 V1 单文件安装留下的所有权记录会被识别为只管理 `SKILL.md`；在其内容哈希仍匹配时，下一次启用会安全升级为文件清单格式。`skill.file` 清单仍受支持。
- 已登记到多个联系人的能力，若要改变 Skill/MCP 适配器类型，需先在所有已登记项目中停用。
- “停用”只从当前联系人项目删除经验证属于 Suzu 的 Skill/MCP 条目。
- “移除”会尝试从所有登记过的项目清理 Suzu 自己的条目。项目丢失、用户冲突或手动修改会中止移除，而不会猜测或删除用户数据。

可直接参考 [最小示例](examples/external-capability/suzu-capability.json)。示例的 `skill/` 目录展示脚本、参考资料和资源的组织方式；其中任何文件都不会被 Suzu Lives 自动执行。示例中的 `server.mjs` 仅用于展示本地路径格式，并不是一个会自动运行的 MCP server。
