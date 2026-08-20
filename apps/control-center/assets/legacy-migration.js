(() => {
  const api = window.legacyMigration;
  const lead = document.querySelector("#lead");
  const summary = document.querySelector("#summary");
  const details = document.querySelector("#details");
  const detailList = document.querySelector("#detail-list");
  const resultBox = document.querySelector("#result");
  const migrateButton = document.querySelector("#migrate");
  const closeButton = document.querySelector("#close");
  let plan = null;

  const message = (value, fallback) => String(value || "").trim() || fallback;

  function addMetric(value, label) {
    const card = document.createElement("div");
    card.className = "metric";
    const number = document.createElement("strong");
    number.textContent = String(value);
    const caption = document.createElement("span");
    caption.textContent = label;
    card.append(number, caption);
    summary.append(card);
  }

  function addDetail(text) {
    const item = document.createElement("li");
    item.textContent = text;
    detailList.append(item);
  }

  function showResult(kind, title, lines = []) {
    resultBox.hidden = false;
    resultBox.className = `result ${kind}`;
    resultBox.replaceChildren();
    const heading = document.createElement("p");
    heading.textContent = title;
    heading.style.fontWeight = "700";
    resultBox.append(heading);
    for (const line of lines) {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      resultBox.append(paragraph);
    }
  }

  function renderPlan(value) {
    plan = value;
    const totals = value?.totals || {};
    summary.replaceChildren();
    addMetric(totals.contacts || 0, "识别到的旧联系人");
    addMetric(totals.nativeTranscriptImports || 0, "可转换的旧对话");
    addMetric(totals.connections || 0, "可接管的旧连接");
    detailList.replaceChildren();

    const contactInstructions = Number(totals.contactInstructions || 0);
    const compatibleMemory = Number(totals.compatibleMemoryDatabases || 0);
    if (contactInstructions) addDetail(`${contactInstructions} 个联系人将从 CLAUDE.md 切换为 SUZU.md。`);
    if (compatibleMemory) addDetail(`${compatibleMemory} 个长期记忆数据库已兼容，会原样保留。`);
    for (const item of Array.isArray(value?.errors) ? value.errors : []) addDetail(`已保留：${message(item?.message, "一个联系人无法安全检查。")}`);
    for (const note of Array.isArray(value?.notes) ? value.notes : []) addDetail(note);
    details.hidden = detailList.childElementCount === 0;

    if (value?.status === "none") {
      lead.textContent = "没有发现需要由迁移助手处理的 0.1.x Suzu Lives 数据。可以直接关闭并使用新版。";
      migrateButton.hidden = true;
      closeButton.textContent = "关闭";
      return;
    }
    lead.textContent = "已找到旧版本地数据。迁移只在这次窗口中执行；你也可以跳过，旧数据会保持不变。";
    migrateButton.disabled = false;
  }

  async function inspect() {
    if (!api?.inspect) {
      showResult("error", "迁移助手无法启动。", ["新版安装文件缺少受限的本地迁移接口。请重新下载安装包。"]);
      return;
    }
    try {
      const response = await api.inspect();
      if (!response?.ok) throw new Error(message(response?.error?.message, "无法检查旧版数据。"));
      renderPlan(response.value);
    } catch (error) {
      lead.textContent = "无法安全检查旧版数据。";
      showResult("error", "未执行迁移。", [message(error?.message, "请关闭后重试；原数据没有被修改。")]);
    }
  }

  async function migrate() {
    if (!plan || !api?.migrate) return;
    migrateButton.disabled = true;
    closeButton.disabled = true;
    lead.textContent = "正在迁移并逐项验证本地数据，请不要关闭此窗口…";
    try {
      const response = await api.migrate();
      if (!response?.ok) throw new Error(message(response?.error?.message, "迁移没有完成。"));
      const value = response.value || {};
      const warnings = Array.isArray(value.warnings) ? value.warnings : [];
      const completed = value.status === "completed" || value.status === "nothing-to-migrate";
      lead.textContent = completed ? "迁移检查已完成。现在可以关闭此窗口并启动新版。" : "迁移已尽可能完成；有少量文件被安全保留。";
      showResult(completed ? "success" : "warning", completed ? "迁移完成" : "迁移部分完成", [
        completed ? "旧对话仅在转换为原生会话并通过校验后才被删除。" : "未能安全映射或已被手动修改的旧文件没有被删除。",
        ...warnings,
      ]);
      migrateButton.hidden = true;
      closeButton.disabled = false;
      closeButton.textContent = "完成并关闭";
    } catch (error) {
      lead.textContent = "迁移没有完成，原始数据已按安全规则保留。";
      showResult("error", "迁移失败", [message(error?.message, "请关闭后重试。")]);
      migrateButton.disabled = false;
      closeButton.disabled = false;
    }
  }

  closeButton.addEventListener("click", () => {
    if (api?.close) void api.close();
    else window.close();
  });
  migrateButton.addEventListener("click", () => { void migrate(); });
  void inspect();
})();
