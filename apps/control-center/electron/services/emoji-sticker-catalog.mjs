function clean(value) {
  return String(value ?? "").trim();
}

function resolveLibrary(value) {
  return typeof value === "function" ? value() : value;
}

function favoriteItem(item) {
  return Object.freeze({
    ...item,
    builtIn: false,
    category: "favorites",
    categoryId: "favorites",
    categoryName: "收藏表情",
  });
}

async function librarySnapshot(libraryValue, { annotate = (item) => item, label }) {
  const library = resolveLibrary(libraryValue);
  if (!library || typeof library.snapshot !== "function") {
    return { items: [], status: "empty" };
  }
  try {
    const snapshot = await library.snapshot();
    const items = Object.freeze((Array.isArray(snapshot?.items) ? snapshot.items : []).map(annotate));
    return {
      ...snapshot,
      items,
      status: clean(snapshot?.status) || (items.length ? "ready" : "empty"),
    };
  } catch (error) {
    return {
      items: [],
      message: error instanceof Error ? error.message : `无法读取${label}。`,
      status: "invalid",
    };
  }
}

export function createEmojiStickerCatalog({ builtinLibrary = null, customLibrary = null } = {}) {
  const builtins = () => librarySnapshot(builtinLibrary, { label: "内置表情" });
  const favorites = () => librarySnapshot(customLibrary, { annotate: favoriteItem, label: "收藏表情" });

  const libraryForId = (id) => {
    const stickerId = clean(id);
    const library = resolveLibrary(stickerId.startsWith("builtin:") ? builtinLibrary : customLibrary);
    if (!library) throw new Error(stickerId.startsWith("builtin:") ? "内置表情资源尚未就绪。" : "收藏表情库尚未就绪。");
    return { library, stickerId };
  };

  return Object.freeze({
    asset: async (id) => {
      const { library, stickerId } = libraryForId(id);
      const item = await library.asset(stickerId);
      return stickerId.startsWith("builtin:") ? item : favoriteItem(item);
    },
    builtins,
    favorites,
    read: async (id) => {
      const { library, stickerId } = libraryForId(id);
      const item = await library.read(stickerId);
      return stickerId.startsWith("builtin:") ? item : favoriteItem(item);
    },
    snapshot: async () => {
      const [builtinSnapshot, favoriteSnapshot] = await Promise.all([builtins(), favorites()]);
      const items = Object.freeze([...builtinSnapshot.items, ...favoriteSnapshot.items]);
      const issues = [builtinSnapshot, favoriteSnapshot]
        .filter((snapshot) => clean(snapshot.status) === "invalid")
        .map((snapshot) => clean(snapshot.message))
        .filter(Boolean);
      return Object.freeze({
        categories: Object.freeze([
          { count: builtinSnapshot.items.length, id: "suzu", name: "Suzu 内置表情", type: "builtin" },
          { count: favoriteSnapshot.items.length, id: "favorites", name: "收藏表情", type: "favorites" },
        ]),
        items,
        ...(issues.length ? { message: issues.join("；") } : {}),
        status: items.length
          ? (issues.length ? "partial" : "ready")
          : (issues.length ? "invalid" : "empty"),
      });
    },
  });
}
