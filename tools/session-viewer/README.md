# 会话查看器

在本机浏览 Claude Code 会话 JSONL，把原始记录还原成更容易阅读的对话界面。

它保留原工具已有的完整视图：

- 用户与助手消息；
- 系统消息；
- `hook_additional_context` 等上下文附件；
- 思考块；
- 工具调用、参数和工具结果。
- 搜索整份会话 JSONL，而不只是页面当前显示的最近消息。
- 点击搜索结果的“定位到对话”，读取该记录前后的原始内容并跳到对应位置。

查看器只读取文件，不修改会话，不调用模型或 API，也不产生 token。

## 启动

如果已经配置 Suzu Lives 压缩器，查看器会自动复用：

```text
memory/manual_compactor/config.local.json
```

中的 `transcriptPath`，直接运行：

```powershell
node .\tools\session-viewer\server.mjs
```

也可以双击 `tools/session-viewer/start.cmd`。

浏览器打开：

```text
http://127.0.0.1:8765
```

如果没有使用压缩器，把 `config.example.json` 复制为 `config.local.json`，填写 `sessionFilePath`。私人配置已被 `.gitignore` 排除。

临时查看其他会话时不需要改配置：

```powershell
node .\tools\session-viewer\server.mjs --transcript "C:\路径\会话.jsonl"
```

可用参数：

- `--port 8765`：修改本机端口；
- `--max 500`：修改页面最多显示的消息数量；
- 环境变量 `SUZU_TRANSCRIPT_PATH`：临时指定会话文件。

## 与旧版本的区别

旧工具每两秒把整份 JSONL 重新读入内存并发送给浏览器。会话不断增长后，磁盘读取、网络传输和页面解析都会越来越重。

新版首次启动时流式扫描文件，之后只读取末尾新增字节。为了避免长会话拖慢页面，实时会话
只缓存和渲染末尾有限数量的记录，所以不能靠无限向上滚动查看整份文件。JSONL 中更早的记录
并没有因此消失；压缩器重写或替换 JSONL 后，查看器也会自动重新扫描。

顶部搜索框会流式扫描整份 JSONL。结果过多时保留最近 100 条。点击结果旁的“定位到对话”，
服务端会从原文件读取命中记录前后各 100 行，显示完整聊天语境并高亮目标记录。可以返回搜索
结果继续查看其他命中，也可以点击“返回会话”回到实时页面。搜索和定位都只读，不会改动会话文件。

## 隐私边界

- 只监听 `127.0.0.1`，不会开放给局域网；
- 页面只显示 JSONL 文件名，不暴露完整本地路径；
- 不提供 `config.local.json` 或整份 JSONL 的下载地址；
- 不联网、不上传任何消息；
- 会话内容以文本方式渲染，不作为网页代码执行。

关闭运行它的终端即可停止。
