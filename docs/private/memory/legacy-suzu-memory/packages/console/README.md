# @suzu-memory/console

Suzu Memory 的本地记忆审核台。它是由 `@suzu-memory/server` 托管的一组静态资源，不直接读取 SQLite，也不保存另一份记忆业务逻辑。

启动 Server 后访问：

```text
http://127.0.0.1:37779/console/
```

审核台通过现有 `/v1` API 提供：

- `ingestion`、`reported-state`、`structure`、`relation` 和 `maintenance-failure` 的统一审核；
- 候选将写入的内容、当前状态、成员/端点和原始证据；
- 进一步分析连续失败三次后的原候选、临时记忆和逐次错误记录；
- 阻塞事件、运行中或失败批次、维护任务状态；
- 当前数据库完整性与最近备份健康；
- 接受、驳回、安全关系撤销、过期批次恢复和创建快照。

`ingestion` 审核不会再次调用模型。人工接受时复用原候选、原始来源和状态分析请求中已经确定的主体信息直接写入；人工驳回只结束这次升级候选，原始事件和证据仍然保留。

如果 Server 配置了 API Key，在页面的“连接设置”中输入。密钥只写入浏览器 `sessionStorage`，关闭当前页面会话后消失。
