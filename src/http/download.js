/**
 * 下载相关的 HTTP 细节：Range 解析与 Content-Disposition 编码。
 * 独立出来是为了能单测——这里最容易写出边界 bug。
 */

import { badRequest } from '../errors.js';

const MAX_ARCHIVE_ENTRIES = 500;

/**
 * 解析打包下载的 idx 列表：`0,2,3`。
 * 与单文件下载不同，这里不允许静默跳过坏序号——用户看到的压缩包必须和请求一致。
 *
 * @param {string|null} raw
 * @param {number} maxIndexExclusive 允许的最大序号 + 1（焚毁后序号可能有空洞，不能直接用文件个数）
 * @returns {number[]} 去重、升序的序号
 */
export function parseIndexList(raw, maxIndexExclusive) {
  const total = Number(maxIndexExclusive);
  if (!Number.isSafeInteger(total) || total < 0) throw badRequest('文件序号范围非法');
  if (typeof raw !== 'string' || raw.trim() === '') throw badRequest('请指定要打包的文件');

  const parts = raw.split(',');
  if (parts.length > MAX_ARCHIVE_ENTRIES) {
    throw badRequest(`一次最多打包 ${MAX_ARCHIVE_ENTRIES} 个文件`);
  }

  const seen = new Set();
  const list = [];
  for (const part of parts) {
    const text = part.trim();
    if (!/^\d{1,6}$/.test(text)) throw badRequest('文件序号非法');
    const idx = Number(text);
    if (idx >= total) throw badRequest('文件序号超出范围');
    if (seen.has(idx)) continue;
    seen.add(idx);
    list.push(idx);
  }
  if (list.length === 0) throw badRequest('请指定要打包的文件');
  list.sort((a, b) => a - b);
  return list;
}

/**
 * 解析 Range 头。
 * @returns {null | { start: number, end: number } | { unsatisfiable: true }}
 *   返回 null 表示「忽略该头，返回完整内容」
 */
export function parseRange(header, size) {
  if (!header || typeof header !== 'string' || size <= 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return null;

  let start;
  let end;

  if (startRaw === '') {
    // bytes=-N：最后 N 个字节
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    if (suffix >= size) return { start: 0, end: size - 1 };
    start = size - suffix;
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start > end || start >= size) return { unsatisfiable: true };
    end = Math.min(end, size - 1);
  }

  return { start, end };
}

/** RFC 5987 / RFC 6266：同时给出 ASCII 回退名与 UTF-8 编码名 */
export function contentDisposition(fileName, type = 'attachment') {
  const name = String(fileName ?? '') || 'file';
  // 回退名只保留可打印 ASCII，去掉引号与反斜杠，避免头注入
  const fallback = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 150) || 'file';

  const encoded = encodeURIComponent(name)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 文件版本标识：大小 + 修改时间。
 * 用于 If-Range：文件被重新上传后不允许把两个版本拼在一起。
 */
export function fileEtag(stat) {
  const size = Number(stat?.size ?? 0);
  const mtime = Math.floor(Number(stat?.mtimeMs ?? 0));
  return `"${size.toString(16)}-${mtime.toString(16)}"`;
}

/**
 * If-Range 是否允许继续使用 Range。
 * 缺省（没有这个头）允许；弱 ETag、HTTP 日期等不支持的形式一律按「不一致」处理，
 * 退化为返回完整文件，安全但稍慢。
 */
export function ifRangeMatches(header, etag) {
  if (header === undefined || header === null || header === '') return true;
  const value = String(header).trim();
  if (value.startsWith('W/')) return false;
  return value === etag;
}
