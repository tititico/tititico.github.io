/*!
 * qrcode.js — 极简 QR Code 编码器（Byte 模式，版本 1-40，纠错等级 L/M/Q/H）
 * 无任何外部依赖，可离线运行。算法参照 ISO/IEC 18004 标准。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.QRCode = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 纠错等级 -> 索引
  const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  // 纠错等级在格式信息里的编码
  const ECL_FORMAT_BITS = [1, 0, 3, 2];

  // 每块的纠错码字数 [等级][版本]
  const ECC_CODEWORDS_PER_BLOCK = [
    // 0  1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
    [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
  ];

  // 纠错块数量 [等级][版本]
  const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
  ];

  const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  // ---------- GF(256) 有限域运算 ----------

  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  // 生成多项式的系数（去掉最高次项）
  function rsComputeDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  // 计算里德-所罗门纠错码字
  function rsComputeRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
    }
    return result;
  }

  // ---------- 版本相关的容量计算 ----------

  // 该版本可用于存放数据+纠错的模块总数
  function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  // 该版本+纠错等级下，纯数据码字数
  function getNumDataCodewords(ver, ecl) {
    return (
      Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
    );
  }

  // Byte 模式下字符计数字段的位数
  function charCountBits(ver) {
    return ver <= 9 ? 8 : 16;
  }

  function getAlignmentPatternPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  // ---------- 主流程 ----------

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    // 兜底实现
    const out = [];
    for (const ch of unescape(encodeURIComponent(text))) out.push(ch.charCodeAt(0));
    return out;
  }

  /**
   * 生成二维码矩阵。
   * @param {string} text  待编码文本
   * @param {string} eclName 纠错等级 'L' | 'M' | 'Q' | 'H'
   * @param {object} [opts] { minVersion, maxVersion, boostEcl }
   * @returns {{ size:number, version:number, ecl:string, mask:number, modules:boolean[][] }}
   */
  function generate(text, eclName, opts) {
    opts = opts || {};
    const minVersion = opts.minVersion || 1;
    const maxVersion = opts.maxVersion || 40;
    const boostEcl = opts.boostEcl !== false; // 默认：容量有富余时自动提升纠错等级

    let ecl = ECL_INDEX[String(eclName || 'M').toUpperCase()];
    if (ecl === undefined) ecl = ECL_INDEX.M;

    const bytes = utf8Bytes(text);

    // 选择能容纳数据的最小版本
    let version = -1, dataCapacityBits = 0;
    for (let ver = minVersion; ver <= maxVersion; ver++) {
      const capacity = getNumDataCodewords(ver, ecl) * 8;
      const needed = 4 + charCountBits(ver) + bytes.length * 8;
      if (needed <= capacity) {
        version = ver;
        dataCapacityBits = capacity;
        break;
      }
    }
    if (version < 0) {
      const max = Math.floor((getNumDataCodewords(maxVersion, ecl) * 8 - 4 - 16) / 8);
      throw new Error('内容太长，无法生成二维码（当前纠错等级下最多约 ' + max + ' 字节，实际 ' + bytes.length + ' 字节）');
    }

    // 在不增加版本的前提下，尽量提高纠错等级
    const usedBits = 4 + charCountBits(version) + bytes.length * 8;
    if (boostEcl) {
      for (let e = 3; e > ecl; e--) {
        if (usedBits <= getNumDataCodewords(version, e) * 8) {
          ecl = e;
          dataCapacityBits = getNumDataCodewords(version, e) * 8;
          break;
        }
      }
    }

    // 组装比特流
    const bb = [];
    const appendBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
    };
    appendBits(0x4, 4);                       // Byte 模式标识
    appendBits(bytes.length, charCountBits(version));
    for (const b of bytes) appendBits(b, 8);

    // 结束符 + 补齐到字节边界
    appendBits(0, Math.min(4, dataCapacityBits - bb.length));
    appendBits(0, (8 - (bb.length % 8)) % 8);
    // 交替填充字节
    for (let padByte = 0xec; bb.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) appendBits(padByte, 8);

    const dataCodewords = new Uint8Array(bb.length / 8);
    bb.forEach((bit, i) => {
      dataCodewords[i >>> 3] |= bit << (7 - (i & 7));
    });

    const allCodewords = addEccAndInterleave(dataCodewords, version, ecl);
    return drawMatrix(allCodewords, version, ecl);
  }

  // 分块计算纠错码并交织
  function addEccAndInterleave(data, ver, ecl) {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const rsDiv = rsComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = Array.from(data.slice(k, k + len));
      k += len;
      const ecc = rsComputeRemainder(Uint8Array.from(dat), rsDiv);
      if (i < numShortBlocks) dat.push(0); // 占位，交织时跳过
      blocks.push(dat.concat(Array.from(ecc)));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  // 绘制矩阵：功能图形 -> 数据 -> 选择最优掩码
  function drawMatrix(allCodewords, version, ecl) {
    const size = version * 4 + 17;
    const modules = [];
    const isFunction = [];
    for (let y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }

    const setFunc = (x, y, dark) => {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    };

    // 定位图形（7x7 + 分隔符）
    const drawFinder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFunc(x, y, dist !== 2 && dist !== 4);
        }
      }
    };

    // 定时图形
    for (let i = 0; i < size; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // 校正图形
    const alignPos = getAlignmentPatternPositions(version);
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFunc(alignPos[j] + dx, alignPos[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // 版本信息（版本 >= 7）
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = getBit(bits, i);
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        setFunc(a, b, dark);
        setFunc(b, a, dark);
      }
    }

    const drawFormatBits = (mask) => {
      const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;

      for (let i = 0; i <= 5; i++) setFunc(8, i, getBit(bits, i));
      setFunc(8, 7, getBit(bits, 6));
      setFunc(8, 8, getBit(bits, 7));
      setFunc(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) setFunc(14 - i, 8, getBit(bits, i));

      for (let i = 0; i < 8; i++) setFunc(size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++) setFunc(8, size - 15 + i, getBit(bits, i));
      setFunc(8, size - 8, true); // 固定的深色模块
    };

    drawFormatBits(0); // 先占位，稍后用最优掩码重写

    // 按 Z 字形填入数据码字
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < allCodewords.length * 8) {
            modules[y][x] = getBit(allCodewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }

    const applyMask = (mask) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (isFunction[y][x]) continue;
          let invert;
          switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
            case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            default: throw new Error('非法掩码');
          }
          if (invert) modules[y][x] = !modules[y][x];
        }
      }
    };

    // 选出惩罚分最低的掩码
    let bestMask = 0, minPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(mask);
      drawFormatBits(mask);
      const penalty = getPenaltyScore(modules, size);
      if (penalty < minPenalty) {
        minPenalty = penalty;
        bestMask = mask;
      }
      applyMask(mask); // 异或两次即还原
    }
    applyMask(bestMask);
    drawFormatBits(bestMask);

    return { size, version, ecl: 'LMQH'[ecl], mask: bestMask, modules };
  }

  // ---------- 掩码惩罚评分 ----------

  function finderPenaltyAddHistory(runLength, history, size) {
    if (history[0] === 0) runLength += size; // 计入外侧的浅色边框
    history.pop();
    history.unshift(runLength);
  }

  function finderPenaltyCountPatterns(history) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  }

  function finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, history, size) {
    if (currentRunColor) {
      finderPenaltyAddHistory(currentRunLength, history, size);
      currentRunLength = 0;
    }
    currentRunLength += size;
    finderPenaltyAddHistory(currentRunLength, history, size);
    return finderPenaltyCountPatterns(history);
  }

  function getPenaltyScore(modules, size) {
    let result = 0;

    // 规则 1/3：横向连续同色 & 类定位图形
    for (let y = 0; y < size; y++) {
      let runColor = false, runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          finderPenaltyAddHistory(runLen, history, size);
          if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
          runColor = modules[y][x];
          runLen = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
    }
    // 纵向
    for (let x = 0; x < size; x++) {
      let runColor = false, runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          finderPenaltyAddHistory(runLen, history, size);
          if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
          runColor = modules[y][x];
          runLen = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
    }

    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // 规则 4：深浅色比例失衡
    let dark = 0;
    for (const row of modules) for (const cell of row) if (cell) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;

    return result;
  }

  // ---------- 输出辅助 ----------

  /** 生成 SVG 字符串 */
  function toSvg(qr, opts) {
    opts = opts || {};
    const margin = opts.margin === undefined ? 4 : opts.margin;
    const dark = opts.dark || '#000000';
    const light = opts.light || '#ffffff';
    const dim = qr.size + margin * 2;

    let path = '';
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) path += `M${x + margin},${y + margin}h1v1h-1z`;
      }
    }
    const bg = light === 'transparent' ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
      bg +
      `<path d="${path}" fill="${dark}"/>` +
      `</svg>`
    );
  }

  /** 绘制到 canvas */
  function toCanvas(qr, canvas, opts) {
    opts = opts || {};
    const margin = opts.margin === undefined ? 4 : opts.margin;
    const dark = opts.dark || '#000000';
    const light = opts.light || '#ffffff';
    const target = opts.size || 512;
    const dim = qr.size + margin * 2;
    const scale = Math.max(1, Math.floor(target / dim));
    const px = dim * scale;

    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, px, px);
    if (light !== 'transparent') {
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, px, px);
    }
    ctx.fillStyle = dark;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
      }
    }
    return canvas;
  }

  return { generate, toSvg, toCanvas };
});
