/**
 * ZIP 打包写入器（同构模块）。
 *
 * 只做「打包」不做压缩：所有条目用 store（method 0），
 * 这样长度可预先精确计算、服务端与浏览器都能纯流式写出，
 * 也不依赖 zlib/CompressionStream 的具体实现。
 *
 * 本文件同时被浏览器（/js/zip.js）和 Node 服务端（经 src/domain/zip.js
 * 再导出）使用，因此只能依赖标准 JS：Uint8Array / DataView / TextEncoder。
 * CRC32 由调用方注入：服务端用 node:zlib.crc32，浏览器用本文件导出的 crc32。
 *
 * 写入流程：
 *   planArchive(entries)           -> 预先算好偏移与总长度（服务端 Content-Length 用）
 *   writer.beginEntry(planned)     -> 写本地头（带 data descriptor 标志）
 *   writer.writeChunk(bytes)       -> 写数据并累计 CRC
 *   writer.endEntry()              -> 写 data descriptor 并登记中央目录
 *   writer.finish()                -> 写中央目录 + EOCD（必要时 ZIP64）
 *
 * 浏览器暂停/重试时用 abortEntry() 截断回当前条目起点，再重新 beginEntry。
 */

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const VERSION_MADE_BY = 0x031e; // Unix, 3.0
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR = 0x07064b50;

const encoder = new TextEncoder();

/** CRC32 查表（浏览器侧使用；服务端注入 node:zlib.crc32 以免重复算） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 增量 CRC32。
 * @param {Uint8Array} bytes
 * @param {number} [previous=0] 上一次的返回值
 * @returns {number} 无符号 32 位
 */
export function crc32(bytes, previous = 0) {
  let crc = (previous ^ U32_MAX) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ U32_MAX) >>> 0;
}

function toBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError('ZIP 写入只接受 Uint8Array/ArrayBuffer');
}

function encodeName(name) {
  const bytes = encoder.encode(String(name ?? ''));
  if (bytes.length === 0) throw new Error('ZIP 条目名不能为空');
  if (bytes.length > U16_MAX) throw new Error('ZIP 条目名过长');
  return bytes;
}

/** DOS 时间（本地时区；ZIP 格式本身不带时区） */
function dosDateTime(ms) {
  const time = Number(ms);
  const date = Number.isFinite(time) && time > 0 ? new Date(time) : new Date();
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const safeYear = Math.min(year, 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((safeYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 规划整个压缩包：每个条目的本地头/数据/描述符/中央目录偏移与最终总长度。
 * 条目里传入 `{ name, size, mtimeMs }`，返回带 `zip64`、`startOffset` 等的条目。
 *
 * @param {Array<{ name: string, size: number, mtimeMs?: number }>} entries
 * @param {{ forceZip64?: boolean }} [options]
 */
export function planArchive(entries, { forceZip64 = false } = {}) {
  const planned = [];
  let offset = 0;
  let centralSize = 0;
  let anyZip64 = Boolean(forceZip64);

  for (const entry of entries) {
    const name = String(entry?.name ?? '');
    const nameBytes = encodeName(name);
    const size = Number(entry?.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('ZIP 条目大小非法');
    const mtimeMs = Number(entry?.mtimeMs ?? 0) || 0;

    const zip64 = Boolean(forceZip64) || size >= U32_MAX || offset >= U32_MAX;
    const localHeaderLength = 30 + nameBytes.length + (zip64 ? 20 : 0);
    const descriptorLength = zip64 ? 24 : 16;
    const startOffset = offset;
    const dataOffset = startOffset + localHeaderLength;
    const centralHeaderLength = 46 + nameBytes.length + (zip64 ? 28 : 0);

    planned.push({
      name,
      nameBytes: nameBytes.length,
      size,
      mtimeMs,
      zip64,
      startOffset,
      localHeaderLength,
      dataOffset,
      descriptorLength,
      centralHeaderLength,
    });

    offset = dataOffset + size + descriptorLength;
    centralSize += centralHeaderLength;
    anyZip64 = anyZip64 || zip64;
  }

  const centralOffset = offset;
  const archiveZip64 = anyZip64
    || planned.length >= U16_MAX
    || centralOffset >= U32_MAX
    || centralSize >= U32_MAX;
  const endLength = archiveZip64 ? 98 : 22;

  return {
    entries: planned,
    totalLength: centralOffset + centralSize + endLength,
    centralOffset,
    centralSize,
    zip64: archiveZip64,
  };
}

function buildLocalHeader(planned, nameBytes) {
  const extraLength = planned.zip64 ? 20 : 0;
  const buffer = new Uint8Array(30 + nameBytes.length + extraLength);
  const view = new DataView(buffer.buffer);
  const { time, date } = dosDateTime(planned.mtimeMs);

  view.setUint32(0, SIG_LOCAL, true);
  view.setUint16(4, planned.zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  view.setUint16(6, UTF8_FLAG | DATA_DESCRIPTOR_FLAG, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  // 带 data descriptor 时本地头的 CRC/大小先置 0（ZIP64 用 0xFFFFFFFF + extra）
  view.setUint32(14, 0, true);
  view.setUint32(18, planned.zip64 ? U32_MAX : 0, true);
  view.setUint32(22, planned.zip64 ? U32_MAX : 0, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, extraLength, true);
  buffer.set(nameBytes, 30);

  if (planned.zip64) {
    const at = 30 + nameBytes.length;
    view.setUint16(at, 0x0001, true);
    view.setUint16(at + 2, 16, true);
    view.setBigUint64(at + 4, BigInt(planned.size), true);
    view.setBigUint64(at + 12, BigInt(planned.size), true);
  }
  return buffer;
}

function buildDescriptor(planned, crc) {
  const length = planned.zip64 ? 24 : 16;
  const buffer = new Uint8Array(length);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, SIG_DESCRIPTOR, true);
  view.setUint32(4, crc >>> 0, true);
  if (planned.zip64) {
    view.setBigUint64(8, BigInt(planned.size), true);
    view.setBigUint64(16, BigInt(planned.size), true);
  } else {
    view.setUint32(8, planned.size, true);
    view.setUint32(12, planned.size, true);
  }
  return buffer;
}

function buildCentralHeader(entry, nameBytes) {
  const extraLength = entry.zip64 ? 28 : 0;
  const buffer = new Uint8Array(46 + nameBytes.length + extraLength);
  const view = new DataView(buffer.buffer);
  const { time, date } = dosDateTime(entry.mtimeMs);

  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(4, VERSION_MADE_BY, true);
  view.setUint16(6, entry.zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  view.setUint16(8, UTF8_FLAG | DATA_DESCRIPTOR_FLAG, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, entry.crc >>> 0, true);
  view.setUint32(20, entry.zip64 ? U32_MAX : entry.size, true);
  view.setUint32(24, entry.zip64 ? U32_MAX : entry.size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, extraLength, true);
  view.setUint16(32, 0, true); // comment
  view.setUint16(34, 0, true); // disk start
  view.setUint16(36, 0, true); // internal attrs
  view.setUint32(38, 0o100644 << 16, true); // external attrs: -rw-r--r--
  view.setUint32(42, entry.zip64 ? U32_MAX : entry.startOffset, true);
  buffer.set(nameBytes, 46);

  if (entry.zip64) {
    const at = 46 + nameBytes.length;
    view.setUint16(at, 0x0001, true);
    view.setUint16(at + 2, 24, true);
    view.setBigUint64(at + 4, BigInt(entry.size), true);
    view.setBigUint64(at + 12, BigInt(entry.size), true);
    view.setBigUint64(at + 20, BigInt(entry.startOffset), true);
  }
  return buffer;
}

function buildEndRecords({ count, centralOffset, centralSize, zip64 }) {
  const classic = new Uint8Array(22);
  const cv = new DataView(classic.buffer);
  cv.setUint32(0, SIG_EOCD, true);
  cv.setUint16(4, 0, true);
  cv.setUint16(6, 0, true);
  cv.setUint16(8, zip64 ? U16_MAX : count, true);
  cv.setUint16(10, zip64 ? U16_MAX : count, true);
  cv.setUint32(12, zip64 ? U32_MAX : centralSize, true);
  cv.setUint32(16, zip64 ? U32_MAX : centralOffset, true);
  cv.setUint16(20, 0, true);

  if (!zip64) return [classic];

  const eocd64 = new Uint8Array(56);
  const ev = new DataView(eocd64.buffer);
  ev.setUint32(0, SIG_EOCD64, true);
  ev.setBigUint64(4, 44n, true);
  ev.setUint16(12, VERSION_MADE_BY, true);
  ev.setUint16(14, VERSION_ZIP64, true);
  ev.setUint32(16, 0, true);
  ev.setUint32(20, 0, true);
  ev.setBigUint64(24, BigInt(count), true);
  ev.setBigUint64(32, BigInt(count), true);
  ev.setBigUint64(40, BigInt(centralSize), true);
  ev.setBigUint64(48, BigInt(centralOffset), true);

  const locator = new Uint8Array(20);
  const lv = new DataView(locator.buffer);
  lv.setUint32(0, SIG_LOCATOR, true);
  lv.setUint32(4, 0, true);
  lv.setBigUint64(8, BigInt(centralOffset + centralSize), true);
  lv.setUint32(16, 1, true);

  return [eocd64, locator, classic];
}

/**
 * 创建写入器。
 *
 * @param {object} options
 * @param {(chunk: Uint8Array) => Promise<void>|void} options.write 顺序写出
 * @param {(offset: number) => Promise<void>|void} [options.truncate] 回退到指定偏移（浏览器需要）
 * @param {(chunk: Uint8Array, previous: number) => number} [options.crc32] CRC 实现
 * @param {number} [options.now] 默认时间戳
 * @param {boolean} [options.forceZip64] 测试用：强制 ZIP64
 */
export function createZipWriter({
  write,
  truncate = null,
  crc32: crcFn = crc32,
  now = Date.now(),
  forceZip64 = false,
} = {}) {
  if (typeof write !== 'function') throw new TypeError('createZipWriter 需要 write 回调');
  if (typeof crcFn !== 'function') throw new TypeError('createZipWriter 需要 crc32 实现');

  let position = 0;
  let current = null;
  let finished = false;
  const entries = [];

  const push = async (buffer) => {
    await write(buffer);
    position += buffer.length;
  };

  const writer = {
    get position() {
      return position;
    },
    get finished() {
      return finished;
    },
    get entryOpen() {
      return current !== null;
    },

    /** @param {{ name: string, size: number, mtimeMs?: number, zip64?: boolean }} entry */
    async beginEntry(entry) {
      if (finished) throw new Error('ZIP 已收尾，不能再写入');
      if (current) throw new Error('上一个 ZIP 条目还没有结束');
      const name = String(entry?.name ?? '');
      const nameBytes = encodeName(name);
      const size = Number(entry?.size ?? 0);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('ZIP 条目大小非法');
      const mtimeMs = Number(entry?.mtimeMs ?? 0) || now;

      // 与服务端 planArchive 的判定保持一致；planned 条目会直接带 zip64
      const zip64 = entry?.zip64 !== undefined
        ? Boolean(entry.zip64)
        : Boolean(forceZip64) || size >= U32_MAX || position >= U32_MAX;

      const planned = {
        name, nameBytes: nameBytes.length, size, mtimeMs, zip64,
        startOffset: position,
      };
      const header = buildLocalHeader(planned, nameBytes);
      await push(header);
      current = {
        ...planned,
        nameBytesRaw: nameBytes,
        crc: 0,
        written: 0,
        headerLength: header.length,
      };
      return { startOffset: planned.startOffset, zip64 };
    },

    async writeChunk(chunk) {
      if (!current) throw new Error('当前没有打开的 ZIP 条目');
      if (finished) throw new Error('ZIP 已收尾，不能再写入');
      const bytes = toBytes(chunk);
      if (current.written + bytes.length > current.size) {
        throw new Error('写入内容超过声明的条目大小');
      }
      current.crc = crcFn(bytes, current.crc) >>> 0;
      await push(bytes);
      current.written += bytes.length;
    },

    async endEntry() {
      if (!current) throw new Error('当前没有打开的 ZIP 条目');
      if (current.written !== current.size) {
        throw new Error(`条目实际写入 ${current.written} 字节，与声明 ${current.size} 字节不一致`);
      }
      const descriptor = buildDescriptor(current, current.crc);
      await push(descriptor);
      entries.push({
        nameBytesRaw: current.nameBytesRaw,
        crc: current.crc,
        size: current.size,
        zip64: current.zip64,
        startOffset: current.startOffset,
        mtimeMs: current.mtimeMs,
      });
      current = null;
    },

    async abortEntry() {
      if (!current) return false;
      if (typeof truncate !== 'function') {
        throw new Error('当前写入目标不支持回退，无法丢弃未完成的 ZIP 条目');
      }
      const start = current.startOffset;
      await truncate(start);
      position = start;
      current = null;
      return true;
    },

    async finish() {
      if (finished) return { length: position };
      if (current) throw new Error('还有未收尾的 ZIP 条目');
      const centralOffset = position;
      let centralSize = 0;
      for (const entry of entries) {
        const header = buildCentralHeader(entry, entry.nameBytesRaw);
        await push(header);
        centralSize += header.length;
      }
      const zip64 = Boolean(forceZip64)
        || entries.some((entry) => entry.zip64)
        || entries.length >= U16_MAX
        || centralOffset >= U32_MAX
        || centralSize >= U32_MAX;
      for (const record of buildEndRecords({ count: entries.length, centralOffset, centralSize, zip64 })) {
        await push(record);
      }
      finished = true;
      return { length: position, centralOffset, centralSize, zip64 };
    },
  };

  return writer;
}

// ---------------------------------------------------------------------------
// 目录布局与条目命名
// ---------------------------------------------------------------------------

const ILLEGAL_SEGMENT_CHARS = /[\u0000-\u001f\u007f<>:"\\|?*]/g;

function sanitizeSegment(segment) {
  let value = String(segment ?? '')
    .replace(ILLEGAL_SEGMENT_CHARS, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (value === '' || value === '.' || value === '..') value = '_';
  return value.slice(0, 200);
}

/** 把相对路径净化成安全的 ZIP 条目名（只影响压缩包内的展示，不参与服务器路径） */
export function sanitizeEntryName(name) {
  const parts = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..');
  const safe = parts.map(sanitizeSegment);
  return safe.length > 0 ? safe.join('/') : 'file';
}

function withSuffix(name, n) {
  const slash = name.lastIndexOf('/');
  const dir = slash === -1 ? '' : name.slice(0, slash + 1);
  const leaf = slash === -1 ? name : name.slice(slash + 1);
  const dot = leaf.lastIndexOf('.');
  if (dot > 0) return `${dir}${leaf.slice(0, dot)} (${n})${leaf.slice(dot)}`;
  return `${dir}${leaf} (${n})`;
}

/** 去重（大小写不敏感，避免 Windows 解压时冲突）；重名追加 (2)、(3)… */
export function uniqueEntryNames(names) {
  const used = new Set();
  const out = [];
  for (const raw of names) {
    const base = sanitizeEntryName(raw);
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = withSuffix(base, n);
      n += 1;
    }
    used.add(candidate.toLowerCase());
    out.push(candidate);
  }
  return out;
}

/** 压缩包文件名：去路径分隔符/控制字符，保证 .zip 后缀，限制长度 */
function cleanArchiveBase(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
}

export function sanitizeArchiveName(name, fallback = '快传') {
  const raw = cleanArchiveBase(name);
  let base = raw === '' ? cleanArchiveBase(fallback) : raw;
  base = base.replace(/\.zip$/i, '').trim().slice(0, 100).replace(/[. ]+$/g, '');
  if (base === '') base = '快传';
  return `${base}.zip`;
}

function normalizeSegments(relPath) {
  const parts = String(relPath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..');
  return parts.length > 0 ? parts : ['file'];
}

function commonDirectoryPrefix(allSegments) {
  if (allSegments.length === 0) return [];
  let prefix = allSegments[0].slice(0, -1);
  for (const segments of allSegments.slice(1)) {
    const dirs = segments.slice(0, -1);
    const max = Math.min(prefix.length, dirs.length);
    let i = 0;
    while (i < max && prefix[i] === dirs[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }

  // 如果某个被选中的文件本身就正好是这个目录，不能把它当父目录剥掉
  const isFileAtPrefix = (segments) => segments.length === prefix.length
    && segments.every((part, i) => part === prefix[i]);
  while (prefix.length > 0 && allSegments.some(isFileAtPrefix)) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * 根据所选文件计算压缩包布局：
 *   - 共同父目录从条目名里剥掉，压缩包用该目录最后一段命名；
 *   - 没有共同目录时保留完整 relPath，压缩包用 fallbackName（分享标题）命名。
 *
 * @param {{ files: Array<{ idx: number, relPath?: string, name?: string }>, fallbackName?: string }} input
 * @returns {{ basePath: string, archiveName: string, entries: Array<{ idx: number, name: string }> }}
 */
export function deriveArchiveLayout({ files, fallbackName = '快传' } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    return { basePath: '', archiveName: sanitizeArchiveName(fallbackName), entries: [] };
  }

  const normalized = list.map((file) => ({
    idx: Number(file?.idx),
    segments: normalizeSegments(file?.relPath ?? file?.name),
  }));
  const prefix = commonDirectoryPrefix(normalized.map((item) => item.segments));
  const basePath = prefix.join('/');

  const rawEntries = normalized.map((item) => {
    const relative = prefix.length > 0 && prefix.every((part, i) => item.segments[i] === part)
      ? item.segments.slice(prefix.length)
      : item.segments;
    return { idx: item.idx, raw: (relative.length > 0 ? relative : item.segments).join('/') };
  });

  const uniqueNames = uniqueEntryNames(rawEntries.map((entry) => entry.raw));
  const entries = rawEntries.map((entry, index) => ({ idx: entry.idx, name: uniqueNames[index] }));
  const archiveBase = prefix.length > 0 ? prefix[prefix.length - 1] : fallbackName;

  return {
    basePath,
    archiveName: sanitizeArchiveName(archiveBase, fallbackName),
    entries,
  };
}
