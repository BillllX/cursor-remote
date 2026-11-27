/**
 * 跨线共享的保守记忆文本近似匹配工具（供个人记忆 memory.ts 与工作区记忆 workspaceMemory.ts 共用）。
 * 严守极性、数字、路径、flag 完全一致原则，避免跨主题或数值变化的句子误合并。
 */

export type MemoryMatch = {
  matchedId?: string;
  matchKind: "normalized_exact" | "high_similarity";
  similarity: number;
};

const SIMILARITY_THRESHOLD = 0.94;
const HAN_SIMILARITY_THRESHOLD = 0.97;
const POLARITY_RE =
  /不允许|未启用|未开启|不得|不能|不可|不应|不必|无需|不要|禁止|禁用|停用|关闭|必须|务必|应当|需要|允许|启用|开启|否|不|未|无|非|勿|莫|别/g;

/** 常见标点、大小写和空白不承载语义；NFKC 同时统一全角字符。 */
export function normalizeMemoryText(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/重新启动|再次启动/g, "重启")
    .replace(/并且|以及/g, "和")
    // 保留 . / \ - _ 等代码标识符边界；只折叠空白与自然语言标点。
    .replace(/[\s,，。!！?？:：;；'"“”‘’`()（）[\]{}<>《》、]+/g, "");
}

function criticalTokens(text: string) {
  // 数字（含中文数字）、路径和 flags 往往正是命令/配置差异；集合不同就绝不做近似合并。
  const unit = "毫秒|分钟|小时|千字节|兆字节|吉字节|端口|字节|次数|帧|次|遍|个|秒|天|kb|mb|gb|tb|%";
  const number = "(?:\\b\\d+(?:\\.\\d+)*|[〇零一二两三四五六七八九十百千万亿]+)";
  return [
    ...text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .matchAll(new RegExp(`--?[\\w.-]+|(?:[./~][\\w.@%+~/-]+)|(?:${unit})?${number}(?:${unit})?`, "g")),
  ]
    .map((match) => match[0])
    .sort();
}

function polarityTokens(text: string) {
  return [...text.normalize("NFKC").matchAll(POLARITY_RE)].map((match) => match[0]).sort();
}

function hanRatio(text: string) {
  const meaningful = [...text].filter((char) => /[\p{Letter}\p{Number}]/u.test(char));
  if (!meaningful.length) return 0;
  return meaningful.filter((char) => /\p{Script=Han}/u.test(char)).length / meaningful.length;
}

const SAFE_HAN_TYPO_GROUPS = ["状壮", "查察", "已以", "的地得", "做作"];

function isSafeHanTypo(left: string, right: string) {
  const a = [...left];
  const b = [...right];
  if (a.length !== b.length || a.length < 24) return false;
  let changed = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) continue;
    changed += 1;
    if (changed > 2 || !SAFE_HAN_TYPO_GROUPS.some((group) => group.includes(a[index]) && group.includes(b[index]))) return false;
  }
  return changed > 0;
}

function canonicalSafeHanTypos(text: string) {
  let out = text;
  for (const group of SAFE_HAN_TYPO_GROUPS) {
    const canonical = [...group][0];
    for (const variant of [...group].slice(1)) out = out.split(variant).join(canonical);
  }
  return out;
}

function grams(text: string) {
  const chars = [...text];
  const size = chars.length < 6 ? 2 : 3;
  return new Set(chars.slice(0, Math.max(0, chars.length - size + 1)).map((_, index) => chars.slice(index, index + size).join("")));
}

function terms(text: string) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const out = normalized.match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? [];
  return new Set(
    out.flatMap((term) => {
      if (!/^\p{Script=Han}+$/u.test(term) || [...term].length < 3) return [term];
      const chars = [...term];
      return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
    }),
  );
}

function dice(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return 1;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return 1;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return common / (left.size + right.size - common);
}

/**
 * 保守近似：关键 token 与语义极性必须完全相同；规范化后先精确匹配，否则仅长度 >= 16
 * 且 3-gram Dice(75%) + term Jaccard(25%) >= 0.94 才算重复。高 Han 占比文本提高到
 * 0.97；极性、数字、路径、flag 的细微变化已由前置硬守卫拒绝。已知中文错字只在
 * 长度 >= 24、等长且最多两个形近/同音误字时参与评分归一化，最终仍必须达到阈值。
 */
export function memoryTextMatch(left: string, right: string): Omit<MemoryMatch, "matchedId"> | null {
  if (criticalTokens(left).join("\0") !== criticalTokens(right).join("\0")) return null;
  if (polarityTokens(left).join("\0") !== polarityTokens(right).join("\0")) return null;
  const a = normalizeMemoryText(left);
  const b = normalizeMemoryText(right);
  if (a === b) return { matchKind: "normalized_exact", similarity: 1 };
  if (Math.min([...a].length, [...b].length) < 16) return null;
  const mostlyHan = Math.min(hanRatio(a), hanRatio(b)) >= 0.6;
  const safeTypo = mostlyHan && isSafeHanTypo(a, b);
  const scoreA = safeTypo ? canonicalSafeHanTypos(a) : a;
  const scoreB = safeTypo ? canonicalSafeHanTypos(b) : b;
  const similarity = 0.75 * dice(grams(scoreA), grams(scoreB)) + 0.25 * jaccard(terms(scoreA), terms(scoreB));
  const threshold = mostlyHan ? HAN_SIMILARITY_THRESHOLD : SIMILARITY_THRESHOLD;
  return similarity >= threshold
    ? { matchKind: "high_similarity", similarity: Number(similarity.toFixed(3)) }
    : null;
}
