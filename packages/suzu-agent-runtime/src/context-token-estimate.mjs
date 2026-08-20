const DENSE_CONTEXT_CHARACTER = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\u3040-\u30FF\uAC00-\uD7AF]/u;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function conservativeTextTokens(value) {
  const text = String(value ?? "");
  let dense = 0;
  let ordinary = 0;
  for (const character of text) {
    if (DENSE_CONTEXT_CHARACTER.test(character)) dense += 1;
    else ordinary += 1;
  }
  return dense + Math.ceil(ordinary / 4);
}

export function conservativeSerializedTokens(value) {
  try {
    return conservativeTextTokens(JSON.stringify(value));
  } catch {
    return conservativeTextTokens(String(value ?? ""));
  }
}

export function conservativeContentTokens(content) {
  if (!Array.isArray(content)) return conservativeSerializedTokens(content);
  let total = 0;
  for (const candidate of content) {
    const block = plainObject(candidate);
    switch (block.type) {
      case "text":
      case "reasoning":
        total += conservativeTextTokens(block.text) + 4;
        break;
      case "tool-call":
        total += conservativeTextTokens(block.name)
          + conservativeSerializedTokens(block.arguments)
          + 4;
        break;
      case "tool-result":
        total += conservativeContentTokens(block.content) + 4;
        break;
      default:
        total += conservativeSerializedTokens(block) + 4;
        break;
    }
  }
  return total;
}

export function conservativeMessageTokens(message) {
  return conservativeContentTokens(plainObject(message).content) + 4;
}

export function conservativeHeaderTokens(header) {
  const source = plainObject(header);
  return conservativeSerializedTokens(source.system)
    + conservativeSerializedTokens(source.tools);
}
