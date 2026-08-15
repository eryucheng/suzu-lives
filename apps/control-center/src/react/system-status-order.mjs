const STATE_PRIORITY = Object.freeze({
  error: 0,
  warning: 1,
  notice: 2,
  missing: 3,
  ok: 4,
});

function stateOf(item) {
  return String(item?.state || "").trim().toLowerCase();
}

export function systemStatusItemPriority(item) {
  return STATE_PRIORITY[stateOf(item)] ?? STATE_PRIORITY.ok;
}

export function sortSystemStatusItems(items) {
  const source = Array.isArray(items) ? items : [];
  return source
    .map((item, index) => ({ index, item, priority: systemStatusItemPriority(item) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ item }) => item);
}

export function sortSystemStatusSections(sections) {
  const source = Array.isArray(sections) ? sections : [];
  return source
    .map((section, index) => {
      const items = sortSystemStatusItems(section?.items);
      return {
        index,
        items,
        priority: items.length ? systemStatusItemPriority(items[0]) : STATE_PRIORITY.ok,
        section,
      };
    })
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ items, section }) => ({ ...section, items }));
}
