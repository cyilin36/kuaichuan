/**
 * 请求体读取与限制。
 */

import { badRequest, payloadTooLarge, unsupportedMediaType } from '../errors.js';

/** API 的 JSON 请求体上限（文本分享最大也只需 1MB 多一点） */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export async function readJsonBody(req, { maxBytes = MAX_JSON_BYTES } = {}) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw payloadTooLarge('请求体过大');
    chunks.push(chunk);
  }

  if (size === 0) return {};

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'bad_request' || err?.httpStatus === 400) throw err;
    throw badRequest('请求体不是合法 JSON');
  }
}

/** 上传类请求要求二进制内容 */
export function assertOctetStream(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== '' && type !== 'application/octet-stream' && type !== 'application/x-www-form-urlencoded') {
    throw unsupportedMediaType('请以 application/octet-stream 上传文件内容');
  }
}

/** 解析 Content-Length（可能不存在） */
export function contentLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
