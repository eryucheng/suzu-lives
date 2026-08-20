# 外部能力清单（V1）

Suzu Lives 的外部能力清单是 Agent 中立的本地描述文件。它描述一个能力有哪些适配器，不假定任何其他宿主专属字段。

> 当前版本状态：安装器已经接入。导入只校验并保存用户明确选择的本地清单；启用后会将 Skill 和 MCP 登记到 **Suzu 管理的全局 Agent Core**，供所有联系人在下一次聊天中使用。导入、启用和停用本身不会下载依赖或运行第三方代码；MCP 只会在下一次由 Suzu 启动 Agent Core 时按已登记配置启动。

## 文件与导入范围

建议将清单命名为 `suzu-capability.json`。导入只读取用户明确选择的本地清单及其本地包文件：不会下载依赖、不会启动 CLI、不会启动 MCP server，也不会联网探测。

届时，Suzu Lives 会保留一份审计副本：

```text
<Suzu 数据目录>/external-capabilities/registry.json
<Suzu 数据目录>/external-capabilities/manifests/<capability-id>/suzu-capability.json
```

原始清单或 Skill 源文件/目录后来丢失时，页面应显示静态诊断。原始清单丢失不影响审计副本；Skill 包或本地 MCP 文件丢失时不能新启用或更新登记。

启用时，Suzu 只在自己的 Agent Core 数据目录写入受管内容：

```text
<Suzu 数据目录>/agent-runtime/core/skills/suzu-external-<capability-id>/
<Suzu 数据目录>/agent-runtime/core/.suzu-external-capabilities.json
<Suzu 数据目录>/agent-runtime/core/suzu-external-capabilities.cordis.patch.yml
```

前者是 Agent Core 的用户 Skill 目录；后两者分别记录 Suzu 自己的 MCP 登记和仅传给 Suzu 所启动子进程的配置 patch。它们不是联系人工作区文件。

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

Skill 内容采用标准 frontmatter；清单和包结构本身仍保持 Agent 中立，能否被某个宿主使用取决于对应安装器。

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

## 当前更新、停用与移除语义

- 再次导入相同 `id` 会更新已保存清单；若全局 Agent Core 仍登记旧版本，页面会提示再次启用更新受管登记。
- 更新目录型 Skill 时，只会删除新包不再提供、且内容哈希仍匹配的旧受管文件；不会删除用户后来加到受管目录里的文件。停用和移除使用同一规则。
- 早期 V1 单文件安装留下的所有权记录会被识别为只管理 `SKILL.md`；在其内容哈希仍匹配时，下一次启用会安全升级为文件清单格式。`skill.file` 清单仍受支持。
- 已启用的能力若要改变 Skill/MCP 适配器类型，需先停用；运行时是全局的，不会按联系人复制登记。
- “停用”只从 Suzu 管理的 Agent Core 删除经验证属于 Suzu 的 Skill/MCP 条目，并让 Suzu 自己的子进程在下次聊天前重载配置。
- “移除”会先执行同样的安全清理，再删除 Suzu 的清单登记与审计副本。受管文件、MCP patch 或状态记录被手动修改时会中止，不会猜测或删除用户数据。

可直接参考 [最小示例](examples/external-capability/suzu-capability.json)。示例的 `skill/` 目录展示脚本、参考资料和资源的组织方式；其中任何文件都不会被 Suzu Lives 自动执行。示例中的 `server.mjs` 仅用于展示本地路径格式，并不是一个会自动运行的 MCP server。
