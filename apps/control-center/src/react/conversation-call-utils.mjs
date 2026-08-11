export function cleanCallText(value) {
  return String(value ?? "").trim();
}

export function callStatusLabel(call) {
  const phase = cleanCallText(call?.phase);
  if (cleanCallText(call?.label)) return cleanCallText(call.label);
  if (phase === "connecting") return "正在接通…";
  if (phase === "thinking") return "正在想怎么回答…";
  if (phase === "speaking") return "正在说话…";
  if (phase === "error") return "通话出了点问题";
  if (phase === "ending") return "正在挂断…";
  return "正在听你说…";
}

export function downsamplePcm16(input, inputRate, targetRate = 16000) {
  const source = input instanceof Float32Array ? input : new Float32Array(0);
  const rate = Number(inputRate) || targetRate;
  if (!source.length || rate < 1) return new Int16Array(0);
  if (rate === targetRate) {
    const output = new Int16Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, source[index] || 0));
      output[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    }
    return output;
  }
  const ratio = rate / targetRate;
  const length = Math.max(1, Math.floor(source.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(source.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let total = 0;
    for (let cursor = start; cursor < end; cursor += 1) total += source[cursor] || 0;
    const sample = Math.max(-1, Math.min(1, total / Math.max(1, end - start)));
    output[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return output;
}

export function inputEnergy(input) {
  if (!input?.length) return 0;
  let total = 0;
  for (let index = 0; index < input.length; index += 1) total += input[index] * input[index];
  return Math.sqrt(total / input.length);
}
