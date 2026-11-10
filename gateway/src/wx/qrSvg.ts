/**
 * 零外部依赖的微信二维码 SVG 生成器（基于 Kazuhiko Arase MIT QRCode 算法，纯 TypeScript 实现）。
 * 用于将腾讯 iLink 返回的 `qrcode_img_content`（如 `https://liteapp.weixin.qq.com/q/...`）
 * 直接渲染为内联 SVG 字符串或 `data:image/svg+xml;utf8,...`，彻底免除任何第三方图片 API 或 canvas 依赖。
 */

const MODE_8BIT_BYTE = 1 << 2;

const ERROR_CORRECT_LEVEL = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2,
} as const;

const EXP_TABLE = new Array<number>(256);
const LOG_TABLE = new Array<number>(256);

for (let i = 0; i < 8; i++) {
  EXP_TABLE[i] = 1 << i;
}
for (let i = 8; i < 256; i++) {
  EXP_TABLE[i] = EXP_TABLE[i - 4]! ^ EXP_TABLE[i - 5]! ^ EXP_TABLE[i - 6]! ^ EXP_TABLE[i - 8]!;
}
for (let i = 0; i < 255; i++) {
  LOG_TABLE[EXP_TABLE[i]!] = i;
}

function glog(n: number): number {
  if (n < 1) throw new Error(`glog(${n})`);
  return LOG_TABLE[n]!;
}

function gexp(n: number): number {
  let v = n;
  while (v < 0) v += 255;
  while (v >= 256) v -= 255;
  return EXP_TABLE[v]!;
}

class QRPolynomial {
  readonly num: number[];

  constructor(num: number[], shift: number) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) {
      offset++;
    }
    this.num = new Array<number>(num.length - offset + shift).fill(0);
    for (let i = 0; i < num.length - offset; i++) {
      this.num[i] = num[i + offset]!;
    }
  }

  get(index: number): number {
    return this.num[index]!;
  }

  getLength(): number {
    return this.num.length;
  }

  multiply(e: QRPolynomial): QRPolynomial {
    const num = new Array<number>(this.getLength() + e.getLength() - 1).fill(0);
    for (let i = 0; i < this.getLength(); i++) {
      for (let j = 0; j < e.getLength(); j++) {
        num[i + j]! ^= gexp(glog(this.get(i)) + glog(e.get(j)));
      }
    }
    return new QRPolynomial(num, 0);
  }

  mod(e: QRPolynomial): QRPolynomial {
    if (this.getLength() - e.getLength() < 0) {
      return this;
    }
    const ratio = glog(this.get(0)) - glog(e.get(0));
    const num = this.num.slice();
    for (let x = 0; x < e.getLength(); x++) {
      num[x]! ^= gexp(glog(e.get(x)) + ratio);
    }
    return new QRPolynomial(num, 0).mod(e);
  }
}

const RS_BLOCK_TABLE: number[][] = [
  [1, 26, 19],
  [1, 26, 16],
  [1, 26, 13],
  [1, 26, 9],
  [1, 44, 34],
  [1, 44, 28],
  [1, 44, 22],
  [1, 44, 16],
  [1, 70, 55],
  [1, 70, 44],
  [2, 35, 17],
  [2, 35, 13],
  [1, 100, 80],
  [2, 50, 32],
  [2, 50, 24],
  [4, 25, 9],
  [1, 134, 108],
  [2, 67, 43],
  [2, 33, 15, 2, 34, 16],
  [2, 33, 11, 2, 34, 12],
  [2, 86, 68],
  [4, 43, 27],
  [4, 43, 19],
  [4, 43, 15],
  [2, 98, 78],
  [4, 49, 31],
  [2, 32, 14, 4, 33, 15],
  [4, 39, 13, 1, 40, 14],
  [2, 121, 97],
  [2, 60, 38, 2, 61, 39],
  [4, 40, 18, 2, 41, 19],
  [4, 40, 14, 2, 41, 15],
  [2, 146, 116],
  [3, 58, 36, 2, 59, 37],
  [4, 36, 16, 4, 37, 17],
  [4, 36, 12, 4, 37, 13],
  [2, 86, 68, 2, 87, 69],
  [4, 69, 43, 1, 70, 44],
  [6, 43, 19, 2, 44, 20],
  [6, 43, 15, 2, 44, 16],
  [4, 101, 81],
  [1, 80, 50, 4, 81, 51],
  [4, 50, 22, 4, 51, 23],
  [3, 36, 12, 8, 37, 13],
  [2, 116, 92, 2, 117, 93],
  [6, 58, 36, 2, 59, 37],
  [4, 46, 20, 6, 47, 21],
  [7, 42, 14, 4, 43, 15],
  [4, 133, 107],
  [8, 59, 37, 1, 60, 38],
  [8, 44, 20, 4, 45, 21],
  [12, 33, 11, 4, 34, 12],
  [3, 145, 115, 1, 146, 116],
  [4, 64, 40, 5, 65, 41],
  [11, 36, 16, 5, 37, 17],
  [11, 36, 12, 5, 37, 13],
  [5, 109, 87, 1, 110, 88],
  [5, 65, 41, 5, 66, 42],
  [5, 54, 24, 7, 55, 25],
  [11, 36, 12, 7, 37, 13],
];

type RSBlock = { totalCount: number; dataCount: number };

function getRSBlocks(typeNumber: number, errorCorrectLevel: number): RSBlock[] {
  let offset = 0;
  if (errorCorrectLevel === ERROR_CORRECT_LEVEL.L) offset = 0;
  else if (errorCorrectLevel === ERROR_CORRECT_LEVEL.M) offset = 1;
  else if (errorCorrectLevel === ERROR_CORRECT_LEVEL.Q) offset = 2;
  else offset = 3;
  const rsBlock = RS_BLOCK_TABLE[(typeNumber - 1) * 4 + offset];
  if (!rsBlock) throw new Error(`bad rs block typeNumber=${typeNumber}`);
  const list: RSBlock[] = [];
  for (let i = 0; i < rsBlock.length / 3; i++) {
    const count = rsBlock[i * 3]!;
    const totalCount = rsBlock[i * 3 + 1]!;
    const dataCount = rsBlock[i * 3 + 2]!;
    for (let j = 0; j < count; j++) {
      list.push({ totalCount, dataCount });
    }
  }
  return list;
}

class QRBitBuffer {
  readonly buffer: number[] = [];
  length = 0;

  put(num: number, length: number) {
    for (let i = 0; i < length; i++) {
      this.putBit(((num >>> (length - i - 1)) & 1) === 1);
    }
  }

  getLengthInBits(): number {
    return this.length;
  }

  putBit(bit: boolean) {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) {
      this.buffer.push(0);
    }
    if (bit) {
      this.buffer[bufIndex]! |= 0x80 >>> (this.length % 8);
    }
    this.length++;
  }
}

const PATTERN_POSITION_TABLE: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
];

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

function getBCHDigit(data: number): number {
  let d = data;
  let digit = 0;
  while (d !== 0) {
    digit++;
    d >>>= 1;
  }
  return digit;
}

function getBCHTypeInfo(data: number): number {
  let d = data << 10;
  while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
    d ^= G15 << (getBCHDigit(d) - getBCHDigit(G15));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

function getBCHTypeNumber(data: number): number {
  let d = data << 12;
  while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
    d ^= G18 << (getBCHDigit(d) - getBCHDigit(G18));
  }
  return (data << 12) | d;
}

function getMask(maskPattern: number, i: number, j: number): boolean {
  switch (maskPattern) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default:
      return false;
  }
}

function getErrorCorrectPolynomial(errorCorrectLength: number): QRPolynomial {
  let a = new QRPolynomial([1], 0);
  for (let i = 0; i < errorCorrectLength; i++) {
    a = a.multiply(new QRPolynomial([1, gexp(i)], 0));
  }
  return a;
}

function getLengthInBits(type: number): number {
  return type < 10 ? 8 : 16;
}

function getLostPoint(modules: Array<Array<boolean | null>>, moduleCount: number): number {
  let lostPoint = 0;
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      let sameCount = 0;
      const dark = Boolean(modules[row]![col]);
      for (let r = -1; r <= 1; r++) {
        if (row + r < 0 || moduleCount <= row + r) continue;
        for (let c = -1; c <= 1; c++) {
          if (col + c < 0 || moduleCount <= col + c) continue;
          if (r === 0 && c === 0) continue;
          if (dark === Boolean(modules[row + r]![col + c])) sameCount++;
        }
      }
      if (sameCount > 5) lostPoint += 3 + sameCount - 5;
    }
  }
  return lostPoint;
}

function createData(typeNumber: number, errorCorrectLevel: number, bytes: Uint8Array): number[] {
  const rsBlocks = getRSBlocks(typeNumber, errorCorrectLevel);
  const buffer = new QRBitBuffer();
  buffer.put(MODE_8BIT_BYTE, 4);
  buffer.put(bytes.length, getLengthInBits(typeNumber));
  for (let i = 0; i < bytes.length; i++) {
    buffer.put(bytes[i]!, 8);
  }

  let totalDataCount = 0;
  for (const b of rsBlocks) totalDataCount += b.dataCount;

  if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
    buffer.put(0, 4);
  }
  while (buffer.getLengthInBits() % 8 !== 0) {
    buffer.putBit(false);
  }
  while (true) {
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(0xec, 8);
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(0x11, 8);
  }

  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcdata: number[][] = [];
  const ecdata: number[][] = [];

  for (let r = 0; r < rsBlocks.length; r++) {
    const dcCount = rsBlocks[r]!.dataCount;
    const ecCount = rsBlocks[r]!.totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);

    const dc = new Array<number>(dcCount);
    for (let i = 0; i < dcCount; i++) {
      dc[i] = 0xff & buffer.buffer[i + offset]!;
    }
    offset += dcCount;
    dcdata.push(dc);

    const rsPoly = getErrorCorrectPolynomial(ecCount);
    const rawPoly = new QRPolynomial(dc, rsPoly.getLength() - 1);
    const modPoly = rawPoly.mod(rsPoly);
    const ec = new Array<number>(rsPoly.getLength() - 1);
    for (let x = 0; x < ec.length; x++) {
      const modIndex = x + modPoly.getLength() - ec.length;
      ec[x] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
    }
    ecdata.push(ec);
  }

  const data: number[] = [];
  for (let z = 0; z < maxDcCount; z++) {
    for (let s = 0; s < rsBlocks.length; s++) {
      if (z < dcdata[s]!.length) data.push(dcdata[s]![z]!);
    }
  }
  for (let xx = 0; xx < maxEcCount; xx++) {
    for (let t = 0; t < rsBlocks.length; t++) {
      if (xx < ecdata[t]!.length) data.push(ecdata[t]![xx]!);
    }
  }
  return data;
}

export function buildQrMatrix(text: string): boolean[][] {
  const bytes = Buffer.from(text, "utf8");
  const ecLevel = ERROR_CORRECT_LEVEL.M;

  let typeNumber = 1;
  for (typeNumber = 1; typeNumber <= 15; typeNumber++) {
    const rsBlocks = getRSBlocks(typeNumber, ecLevel);
    let totalDataCount = 0;
    for (const b of rsBlocks) totalDataCount += b.dataCount;
    const neededBits = 4 + getLengthInBits(typeNumber) + bytes.length * 8;
    if (neededBits <= totalDataCount * 8) break;
  }
  if (typeNumber > 15) {
    throw new Error("二维码内容过长，超出版本容量上限");
  }

  const moduleCount = typeNumber * 4 + 17;
  const dataCache = createData(typeNumber, ecLevel, bytes);

  const makeImpl = (test: boolean, maskPattern: number): Array<Array<boolean | null>> => {
    const modules: Array<Array<boolean | null>> = Array.from({ length: moduleCount }, () =>
      new Array<boolean | null>(moduleCount).fill(null),
    );

    const setupPositionProbePattern = (row: number, col: number) => {
      for (let r = -1; r <= 7; r++) {
        if (row + r <= -1 || moduleCount <= row + r) continue;
        for (let c = -1; c <= 7; c++) {
          if (col + c <= -1 || moduleCount <= col + c) continue;
          if (
            (0 <= r && r <= 6 && (c === 0 || c === 6)) ||
            (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
            (2 <= r && r <= 4 && 2 <= c && c <= 4)
          ) {
            modules[row + r]![col + c] = true;
          } else {
            modules[row + r]![col + c] = false;
          }
        }
      }
    };

    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(moduleCount - 7, 0);
    setupPositionProbePattern(0, moduleCount - 7);

    // Position adjust pattern
    const pos = PATTERN_POSITION_TABLE[typeNumber - 1] || [];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const row = pos[i]!;
        const col = pos[j]!;
        if (modules[row]![col] !== null) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            modules[row + r]![col + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
          }
        }
      }
    }

    // Timing pattern
    for (let r = 8; r < moduleCount - 8; r++) {
      if (modules[r]![6] === null) modules[r]![6] = r % 2 === 0;
    }
    for (let c = 8; c < moduleCount - 8; c++) {
      if (modules[6]![c] === null) modules[6]![c] = c % 2 === 0;
    }

    // Type info
    const typeData = (ecLevel << 3) | maskPattern;
    const bits = getBCHTypeInfo(typeData);
    for (let v = 0; v < 15; v++) {
      const mod = !test && ((bits >> v) & 1) === 1;
      if (v < 6) modules[v]![8] = mod;
      else if (v < 8) modules[v + 1]![8] = mod;
      else modules[moduleCount - 15 + v]![8] = mod;
    }
    for (let h = 0; h < 15; h++) {
      const mod = !test && ((bits >> h) & 1) === 1;
      if (h < 8) modules[8]![moduleCount - h - 1] = mod;
      else if (h < 9) modules[8]![15 - h] = mod;
      else modules[8]![15 - h - 1] = mod;
    }
    modules[moduleCount - 8]![8] = !test;

    if (typeNumber >= 7) {
      const tBits = getBCHTypeNumber(typeNumber);
      for (let i = 0; i < 18; i++) {
        const mod = !test && ((tBits >> i) & 1) === 1;
        modules[Math.floor(i / 3)]![(i % 3) + moduleCount - 11] = mod;
        modules[(i % 3) + moduleCount - 11]![Math.floor(i / 3)] = mod;
      }
    }

    // Map data
    let inc = -1;
    let row = moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let col = moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (modules[row]![col - c] === null) {
            let dark = false;
            if (byteIndex < dataCache.length) {
              dark = ((dataCache[byteIndex]! >>> bitIndex) & 1) === 1;
            }
            if (getMask(maskPattern, row, col - c)) {
              dark = !dark;
            }
            modules[row]![col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) {
              byteIndex++;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
    return modules;
  };

  let bestPattern = 0;
  let minLostPoint = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 8; i++) {
    const m = makeImpl(true, i);
    const lost = getLostPoint(m, moduleCount);
    if (lost < minLostPoint) {
      minLostPoint = lost;
      bestPattern = i;
    }
  }

  const finalModules = makeImpl(false, bestPattern);
  return finalModules.map((row) => row.map((cell) => Boolean(cell)));
}

/**
 * 将任意 URL 或文本渲染为独立、清晰的 SVG 二维码 Data URI（`data:image/svg+xml;utf8,...`）
 */
export function renderQrCodeSvgDataUrl(text: string, margin = 2): string {
  const matrix = buildQrMatrix(text);
  const count = matrix.length;
  const total = count + margin * 2;
  const paths: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (matrix[r]![c]) {
        paths.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${paths.join("")}" fill="#000000"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
