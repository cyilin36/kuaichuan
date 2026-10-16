/**
 * 下载相关的 HTTP 细节：Range 解析与 Content-Disposition 编码。
 * 独立出来是为了能单测——这里最容易写出边界 bug。
 */

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
