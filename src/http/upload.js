/**
 * 上传相关的 HTTP 细节。
 *
 * 断点续传用 Upload-Offset 表示「本次请求体从文件的第几个字节开始」，
 * 服务端只接受与 .part 实际大小一致的偏移，避免两个写者把分片写乱。
 */

import { badRequest } from '../errors.js';

/**
 * 解析 Upload-Offset。
 * @returns {number|null} 头不存在返回 null（表示从头开始）
 */
export function parseUploadOffset(header) {
  if (header === undefined || header === null) return null;
  const raw = String(header).trim();
  if (raw === '') return null;
  if (!/^\d+$/.test(raw)) throw badRequest('上传偏移量非法');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw badRequest('上传偏移量非法');
  return value;
}

/** 客户端主动断开/中止上传时，服务端不应把它当作 500 记录 */
export function isClientAbort(err) {
  const code = String(err?.code ?? '');
  if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
    return true;
  }
  return err?.name === 'AbortError';
}
