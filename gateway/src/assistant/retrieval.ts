/**
 * 本地混合检索：关键词（BM25）+ 字符 n-gram 向量 + 实体，三路排名用 RRF 融合。
 *
 * 向量不是语义向量：它是把字符 n-gram（中文二/三字片段、拉丁字母三字片段）哈希进固定维度的词袋，
 * 只能做“字面相近”的模糊匹配（错字、半截词、词序不同）。“牛排”≈“牛肉”、“素食”≈“吃素”这类近义
 * 只能靠共享的字命中，不靠向量。全部本地同步计算，不调外部服务。
 */

export type RetrievalDoc = { text: string; topic?: string };

export type RetrievalHit = { index: number; score: number; bm25: number; cosine: number; entity: number };

export type RetrieveOptions = {
  limit?: number;
  /** 不通过的文档不参与排名 */
  filter?: (index: number) => boolean;
  /** 0..1 的先验分，乘 priorWeight 加到融合分上，只起排序微调作用 */
  prior?: (index: number) => number;
  priorWeight?: number;
};

type Posting = { docs: number[]; tfs: number[] };

export type RetrievalIndex = {
  size: number;
  avgLen: number;
  lens: Uint32Array;
  terms: Map<string | number, Posting>;
  dimDocs: Int32Array[];
  dimWeights: Float32Array[];
  /** 查询里有实体时才按需抽取 */
  entities: Array<Set<string> | undefined>;
  topics: string[];
  texts: string[];
};

const DIMS = 2048;
const K1 = 1.2;
const B = 0.75;
const RRF_K = 60;
/** 只靠向量过闸门的最低余弦 */
const MIN_COSINE = 0.2;
/** 进向量排名的最低余弦，低于这个基本是哈希碰撞噪声 */
const RANK_COSINE = 0.05;
/** 进关键词排名的最低 BM25：只命中九成文档都有的词，等于没有信息，不该拿名次分 */
const RANK_BM25 = 0.1;
const DEFAULT_PRIOR_WEIGHT = 0.004;

const STOP_CJK = new Set([..."的了吗呢吧啊呀嘛哦嗯哈我你他她它是在和与及就都也还又这那个之而或被把给让"]);
const STOP_BIGRAMS = new Set([
  "什么", "怎么", "怎样", "一下", "一个", "这个", "那个", "我们", "你们", "他们", "她们",
  "我的", "你的", "他的", "是不", "不是", "可以", "知道", "记得", "请问", "帮我", "是否", "有没",
]);
const STOP_LATIN = new Set([
  "the", "an", "is", "are", "was", "were", "be", "to", "of", "and", "or", "in", "on", "at", "for", "with", "by",
  "from", "as", "it", "this", "that", "you", "me", "my", "we", "our", "do", "does", "did", "can", "could",
  "what", "how", "when", "where", "who", "why", "which", "please",
]);

function normalize(text: string) {
  return text.normalize("NFKC").toLowerCase();
}

/** 中日（汉字、扩展 A、兼容汉字、假名）按字切；韩文有空格分词，按拉丁词处理 */
function isCjk(c: number) {
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xf900 && c <= 0xfaff);
}

function isWordChar(c: number) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) || (c >= 0xac00 && c <= 0xd7af);
}

/** 把 isCjk 的几个区段压到 0..CJK_SPAN-1，二字片段 码1*CJK_SPAN+码2 就能落在 V8 小整数范围里，不分配堆数字 */
const CJK_SPAN = 0x7100;
function compactCjk(c: number) {
  if (c >= 0x4e00) return c <= 0x9fff ? c - 0x4e00 : 0x6f00 + (c - 0xf900);
  if (c >= 0x3400) return 0x5200 + (c - 0x3400);
  return 0x6e00 + (c - 0x3040);
}
function expandCjk(k: number) {
  if (k < 0x5200) return k + 0x4e00;
  if (k < 0x6e00) return k - 0x5200 + 0x3400;
  if (k < 0x6f00) return k - 0x6e00 + 0x3040;
  return k - 0x6f00 + 0xf900;
}

type Run = { cjk: boolean; text: string };

function runsOf(norm: string) {
  const runs: Run[] = [];
  let kind = 0;
  let start = 0;
  for (let i = 0; i <= norm.length; i += 1) {
    const c = i < norm.length ? norm.charCodeAt(i) : 0;
    const next = isCjk(c) ? 1 : isWordChar(c) ? 2 : 0;
    if (next === kind) continue;
    if (kind) runs.push({ cjk: kind === 1, text: norm.slice(start, i) });
    kind = next;
    start = i;
  }
  return runs;
}

const isDigits = (text: string) => /^\d+$/.test(text);

/**
 * 内部词项：拉丁/数字词是字符串；中日单字是 -(压缩码+1)，二字片段是 压缩码1*CJK_SPAN+压缩码2。
 * 用小整数做键省掉切片、字符串哈希和 GC。
 */
type Term = string | number;

const unigramKey = (c: number) => -(compactCjk(c) + 1);
const bigramKey = (a: number, b: number) => compactCjk(a) * CJK_SPAN + compactCjk(b);

const STOP_CJK_CODES = new Set([...STOP_CJK].map((ch) => ch.charCodeAt(0)));
const STOP_BIGRAM_KEYS = new Set([...STOP_BIGRAMS].map((bi) => bigramKey(bi.charCodeAt(0), bi.charCodeAt(1))));

function tokensOf(runs: Run[]) {
  const out: Term[] = [];
  for (const { cjk, text } of runs) {
    if (!cjk) {
      if ((text.length > 1 || isDigits(text)) && !STOP_LATIN.has(text)) out.push(text);
      continue;
    }
    for (let i = 0; i < text.length; i += 1) {
      const a = text.charCodeAt(i);
      const stopA = STOP_CJK_CODES.has(a);
      if (!stopA) out.push(unigramKey(a));
      if (i + 1 >= text.length) continue;
      const b = text.charCodeAt(i + 1);
      const bi = bigramKey(a, b);
      if (STOP_BIGRAM_KEYS.has(bi) || (stopA && STOP_CJK_CODES.has(b))) continue;
      out.push(bi);
    }
  }
  return out;
}

/** 单个中文字和一位数字算弱词：只靠它们命中不够过闸门 */
function isStrong(term: Term) {
  return typeof term === "string" ? term.length > 1 : term >= 0;
}

const isCjkUnigram = (term: Term) => typeof term === "number" && term < 0;

function termText(term: Term) {
  if (typeof term === "string") return term;
  if (term < 0) return String.fromCharCode(expandCjk(-term - 1));
  return String.fromCharCode(expandCjk(Math.floor(term / CJK_SPAN)), expandCjk(term % CJK_SPAN));
}

/** 小写；拉丁/数字按词；中日韩按单字 + 二字片段；去掉少量停用词 */
export function tokenize(text: string) {
  return tokensOf(runsOf(normalize(text))).map(termText);
}

/** 1~3 个字符码的哈希；末尾 fmix32 打散，否则低位只取决于字符码低位，按维度取模会成片碰撞 */
function hashChars(a: number, b = -1, c = -1) {
  let h = Math.imul(0x811c9dc5 ^ a, 0x01000193);
  if (b >= 0) h = Math.imul(h ^ b, 0x01000193);
  if (c >= 0) h = Math.imul(h ^ c, 0x01000193);
  h = Math.imul(h ^ (c >= 0 ? 3 : b >= 0 ? 2 : 1), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 两个种子的 FNV 拼成 64 位指纹，给缓存做键 */
export function fingerprint(parts: Iterable<string>) {
  let a = 0x811c9dc5;
  let b = 0x01234567;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      const c = part.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
    }
    a = Math.imul(a ^ 0x1f, 0x01000193);
    b = Math.imul(b ^ 0x1f, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

/** 字符 n-gram 哈希向量（带符号哈希，碰撞互相抵消），TF 取 1+log，L2 归一 */
const scratch = new Float64Array(DIMS);
const touched = new Int32Array(DIMS);
let touchedCount = 0;

function addFeature(h: number) {
  const dim = h & (DIMS - 1);
  if (scratch[dim] === 0) touched[touchedCount++] = dim;
  scratch[dim] += h & 0x80000000 ? -1 : 1;
  // 正负抵消回 0 时留个极小值，免得同一维度被重复登记
  if (scratch[dim] === 0) scratch[dim] = 1e-12;
}

const charAt = (text: string, i: number) => (i < 0 || i >= text.length ? 32 : text.charCodeAt(i));

/** 返回 [维度, 权重] 稀疏向量；词频按维度累计后取 1+log，再 L2 归一 */
function vectorOf(runs: Run[]) {
  touchedCount = 0;
  for (const { cjk, text } of runs) {
    const len = text.length;
    if (cjk) {
      if (len === 1) addFeature(hashChars(text.charCodeAt(0)));
      for (let i = 0; i + 1 < len; i += 1) {
        const a = text.charCodeAt(i);
        const b = text.charCodeAt(i + 1);
        addFeature(hashChars(a, b));
        if (i + 2 < len) addFeature(hashChars(a, b, text.charCodeAt(i + 2)));
      }
    } else {
      // 前后各补一个空格再取三字片段
      for (let i = -1; i + 2 <= len; i += 1) addFeature(hashChars(charAt(text, i), charAt(text, i + 1), charAt(text, i + 2)));
    }
  }
  const dims: number[] = [];
  const weights: number[] = [];
  let norm = 0;
  for (let k = 0; k < touchedCount; k += 1) {
    const dim = touched[k];
    const raw = scratch[dim];
    if (raw === 0) continue;
    scratch[dim] = 0;
    const abs = Math.abs(raw);
    if (abs < 0.5) continue;
    const weight = Math.sign(raw) * (1 + Math.log(abs));
    dims.push(dim);
    weights.push(weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let k = 0; k < weights.length; k += 1) weights[k] /= norm;
  return { dims, weights };
}

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function toNumber(text: string) {
  if (isDigits(text)) return Number(text);
  if (!text.includes("十")) return text.length === 1 ? (CN_DIGIT[text] ?? NaN) : NaN;
  const [tens, ones] = text.split("十");
  return (tens ? (CN_DIGIT[tens] ?? NaN) : 1) * 10 + (ones ? (CN_DIGIT[ones] ?? NaN) : 0);
}

const NUM = "(\\d{1,2}|[一二两三四五六七八九十]{1,3})";
const FULL_DATE_RE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g;
const YEAR_MONTH_RE = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*月?(?!\d)/g;
const NUM_MONTH_DAY_RE = /(?<![\d.])(\d{1,2})\s*[-/]\s*(\d{1,2})(?![\d])/g;
const CN_MONTH_DAY_RE = new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日号]?`, "g");
const MONTH_RE = new RegExp(`${NUM}\\s*月(?:份)?`, "g");
const QUOTE_RES = [/「([^」]{1,40})」/g, /『([^』]{1,40})』/g, /“([^”]{1,40})”/g, /"([^"]{1,40})"/g, /《([^》]{1,40})》/g];
const HANDLE_RE = /@[a-z0-9_][\w.-]*/g;
const LATIN_RE = /[a-z][a-z0-9]{2,}/g;
const NUMBER_RE = /\d{2,}/g;

const ENTITY_WEIGHT: Record<string, number> = { d: 2, md: 2, ym: 2, m: 0.5, q: 2, "@": 2, w: 1, n: 1 };

const pad2 = (value: number) => String(value).padStart(2, "0");
const okMonthDay = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;

/** 实体：日期（归一成 月-日 / 年-月-日）、引号里的原文、@名字、拉丁专名、两位以上数字。输入需已 normalize */
function entitiesOf(norm: string) {
  const out = new Set<string>();
  if (/[「『“"《]/.test(norm)) for (const re of QUOTE_RES) for (const m of norm.matchAll(re)) if (m[1].trim()) out.add(`q:${m[1].trim()}`);
  const hasDigit = /\d/.test(norm);
  const hasMonth = norm.includes("月");
  if (!hasDigit && !hasMonth && !norm.includes("@") && !/[a-z]/.test(norm)) return out;
  const monthDay = (all: string, mo: string, d: string) => {
    const month = toNumber(mo);
    const day = toNumber(d);
    if (!okMonthDay(month, day)) return all;
    out.add(`md:${pad2(month)}-${pad2(day)}`);
    out.add(`m:${month}`);
    return " ";
  };
  let rest = norm;
  if (hasDigit) {
    rest = rest.replace(FULL_DATE_RE, (all, y: string, mo: string, d: string) => {
      if (!okMonthDay(+mo, +d)) return all;
      out.add(`d:${y}-${pad2(+mo)}-${pad2(+d)}`);
      out.add(`md:${pad2(+mo)}-${pad2(+d)}`);
      out.add(`m:${+mo}`);
      return " ";
    });
    rest = rest.replace(YEAR_MONTH_RE, (all, y: string, mo: string) => {
      if (+mo < 1 || +mo > 12) return all;
      out.add(`ym:${y}-${pad2(+mo)}`);
      out.add(`m:${+mo}`);
      return " ";
    });
    rest = rest.replace(NUM_MONTH_DAY_RE, monthDay);
  }
  if (hasMonth) {
    rest = rest.replace(CN_MONTH_DAY_RE, monthDay).replace(MONTH_RE, (all, mo: string) => {
      const month = toNumber(mo);
      if (month < 1 || month > 12) return all;
      out.add(`m:${month}`);
      return " ";
    });
  }
  if (rest.includes("@")) {
    rest = rest.replace(HANDLE_RE, (handle) => {
      out.add(`@:${handle.slice(1)}`);
      return " ";
    });
  }
  for (const m of rest.matchAll(LATIN_RE)) if (!STOP_LATIN.has(m[0])) out.add(`w:${m[0]}`);
  if (hasDigit) for (const m of rest.matchAll(NUMBER_RE)) out.add(`n:${m[0]}`);
  return out;
}

export function extractEntities(text: string) {
  return entitiesOf(normalize(text));
}

export function buildIndex(docs: RetrievalDoc[]): RetrievalIndex {
  const size = docs.length;
  const lens = new Uint32Array(size);
  const terms = new Map<Term, Posting>();
  const dimLists: Array<{ docs: number[]; weights: number[] }> = Array.from({ length: DIMS }, () => ({ docs: [], weights: [] }));
  const entities: Array<Set<string> | undefined> = new Array(size);
  const topics: string[] = new Array(size);
  const texts: string[] = new Array(size);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    const topic = normalize(docs[i].topic ?? "").replace(/\s+/g, " ").trim();
    const text = normalize(docs[i].text);
    const runs = runsOf(topic ? `${topic} ${text}` : text);
    const tokens = tokensOf(runs);
    lens[i] = tokens.length;
    total += tokens.length;
    for (const token of tokens) {
      let posting = terms.get(token);
      if (!posting) terms.set(token, (posting = { docs: [], tfs: [] }));
      const last = posting.docs.length - 1;
      if (last >= 0 && posting.docs[last] === i) posting.tfs[last] += 1;
      else {
        posting.docs.push(i);
        posting.tfs.push(1);
      }
    }
    const vector = vectorOf(runs);
    for (let k = 0; k < vector.dims.length; k += 1) {
      const list = dimLists[vector.dims[k]];
      list.docs.push(i);
      list.weights.push(vector.weights[k]);
    }
    topics[i] = topic;
    texts[i] = text;
  }
  return {
    size,
    avgLen: size ? total / size : 0,
    lens,
    terms,
    dimDocs: dimLists.map((list) => Int32Array.from(list.docs)),
    dimWeights: dimLists.map((list) => Float32Array.from(list.weights)),
    entities,
    topics,
    texts,
  };
}

/** 每个槽位（租户 + 索引种类）只留最新一版，租户之间互不挤占 */
const cache = new Map<string, { key: string; index: RetrievalIndex }>();
const CACHE_SLOTS = 64;

/** slot 标识文档集归属，key 是该文档集的版本；版本变了就重建 */
export function cachedIndex(slot: string, key: string, docs: () => RetrievalDoc[]) {
  const hit = cache.get(slot);
  if (hit && hit.key === key) {
    cache.delete(slot);
    cache.set(slot, hit);
    return hit.index;
  }
  const index = buildIndex(docs());
  cache.delete(slot);
  cache.set(slot, { key, index });
  while (cache.size > CACHE_SLOTS) cache.delete(cache.keys().next().value!);
  return index;
}

function topicScore(topic: string, query: string, strongTerms: string[]) {
  if (!topic) return 0;
  if (topic === query) return 3;
  if (topic.length >= 2 && query.includes(topic)) return 2;
  if (query.length >= 2 && topic.includes(query)) return 1.5;
  return strongTerms.some((term) => topic.includes(term)) ? 1 : 0;
}

/** 同分同名次，否则数组顺序会给并列的文档凭空拉开差距 */
function rankInto(fused: Float64Array, candidates: number[], scores: Float64Array, floor: number) {
  const ranked = candidates.filter((doc) => scores[doc] > floor).sort((a, b) => scores[b] - scores[a]);
  let rank = 0;
  for (let r = 0; r < ranked.length; r += 1) {
    if (r === 0 || scores[ranked[r]] < scores[ranked[r - 1]] - 1e-9) rank = r + 1;
    fused[ranked[r]] += 1 / (RRF_K + rank);
  }
}

/**
 * 闸门：至少一个强词（二字片段、拉丁词、多位数字）命中；或短查询（≤3 个单字）的单字全部命中；
 * 或余弦 ≥ MIN_COSINE；或实体/主题命中。无关查询返回空，而不是随便凑几条。
 */
export function retrieve(index: RetrievalIndex, query: string, opts: RetrieveOptions = {}): RetrievalHit[] {
  const n = index.size;
  if (!n) return [];
  const norm = normalize(query);
  const runs = runsOf(norm);
  const queryTerms = [...new Set(tokensOf(runs))];
  const strongTerms = queryTerms.filter(isStrong).map(termText);
  const unigrams = queryTerms.filter(isCjkUnigram);
  const qEntities = entitiesOf(norm);
  const qPlain = norm.replace(/\s+/g, " ").trim();
  if (!qPlain) return [];

  const allowed = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) allowed[i] = !opts.filter || opts.filter(i) ? 1 : 0;

  const bm25 = new Float64Array(n);
  const strongHits = new Uint16Array(n);
  const unigramHits = new Uint16Array(n);
  for (const term of queryTerms) {
    const posting = index.terms.get(term);
    if (!posting) continue;
    const df = posting.docs.length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    const strong = isStrong(term);
    const unigram = isCjkUnigram(term);
    for (let j = 0; j < df; j += 1) {
      const doc = posting.docs[j];
      if (!allowed[doc]) continue;
      const tf = posting.tfs[j];
      bm25[doc] += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * index.lens[doc]) / (index.avgLen || 1)));
      if (strong) strongHits[doc] += 1;
      else if (unigram) unigramHits[doc] += 1;
    }
  }

  const cosine = new Float64Array(n);
  const qVector = vectorOf(runs);
  for (let k = 0; k < qVector.dims.length; k += 1) {
    const weight = qVector.weights[k];
    const docs = index.dimDocs[qVector.dims[k]];
    const weights = index.dimWeights[qVector.dims[k]];
    for (let j = 0; j < docs.length; j += 1) cosine[docs[j]] += weight * weights[j];
  }

  const entity = new Float64Array(n);
  // 查询带了具体日期时，只同月份不算命中闸门，只做排序加分
  const specificDate = [...qEntities].some((e) => e.startsWith("d:") || e.startsWith("md:"));
  const entityGate = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!allowed[i]) continue;
    let score = topicScore(index.topics[i], qPlain, strongTerms);
    let gate = score > 0;
    if (!qEntities.size) {
      entity[i] = score;
      entityGate[i] = gate ? 1 : 0;
      continue;
    }
    const docEntities = (index.entities[i] ??= entitiesOf(index.texts[i]));
    for (const e of qEntities) {
      const hit = docEntities.has(e) || (e.startsWith("q:") && index.texts[i].includes(e.slice(2)));
      if (!hit) continue;
      score += ENTITY_WEIGHT[e.slice(0, e.indexOf(":"))] ?? 1;
      if (!(specificDate && e.startsWith("m:"))) gate = true;
    }
    entity[i] = score;
    entityGate[i] = gate ? 1 : 0;
  }

  const shortQuery = unigrams.length > 0 && unigrams.length <= 3;
  const candidates: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (!allowed[i]) continue;
    const pass = strongHits[i] > 0 || (shortQuery && unigramHits[i] === unigrams.length) || cosine[i] >= MIN_COSINE || entityGate[i] > 0;
    if (pass) candidates.push(i);
  }
  if (!candidates.length) return [];

  const fused = new Float64Array(n);
  rankInto(fused, candidates, bm25, RANK_BM25);
  rankInto(fused, candidates, cosine, RANK_COSINE);
  rankInto(fused, candidates, entity, 0);
  const limit = opts.limit ?? 12;
  const byScore = (a: number, b: number) => fused[b] - fused[a] || bm25[b] - bm25[a] || cosine[b] - cosine[a];
  // 过了闸门但三路都没给名次（常见词、余弦低于排序线）：没有相关性证据，不返回
  let ranked = candidates.filter((doc) => fused[doc] > 0).sort(byScore);
  if (!ranked.length) return [];
  const priorWeight = opts.priorWeight ?? DEFAULT_PRIOR_WEIGHT;
  if (opts.prior && priorWeight > 0) {
    // 先验最多加 priorWeight：比第 limit 名低出这么多的文档加了也进不了前列，不用算
    const cut = ranked.length > limit ? fused[ranked[limit - 1]] - priorWeight : -Infinity;
    ranked = ranked.filter((doc) => fused[doc] >= cut);
    for (const doc of ranked) fused[doc] += priorWeight * Math.max(0, Math.min(1, opts.prior(doc)));
    ranked.sort(byScore);
  }
  return ranked
    .slice(0, limit)
    .map((doc) => ({ index: doc, score: fused[doc], bm25: bm25[doc], cosine: cosine[doc], entity: entity[doc] }));
}
