/**
 * 令牌：
 *   - access token：密码校验通过后签发，用于读取元数据与下载
 *   - owner token：创建分享时下发一次，用于撤销与查看自己的分享（库里只存哈希）
 *
 * 格式：<base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ACCESS_SCOPE = 'access';

function encode(data) {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

/** 签发令牌 */
export function signToken({ secret, shareId, scope = ACCESS_SCOPE, ttlSeconds, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000);
  const payload = { sid: shareId, scope, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const data = encode(payload);
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

/**
 * 校验令牌。任何一项不符都返回 null（不区分原因，避免泄露信息）。
 * @returns {{ sid: string, scope: string, iat: number, exp: number } | null}
 */
export function verifyToken({ secret, token, shareId, scope = ACCESS_SCOPE, now = Date.now() }) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, signature] = parts;

  let expected;
  let given;
  try {
    expected = createHmac('sha256', secret).update(data).digest();
    given = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.scope !== scope) return null;
  if (shareId !== undefined && payload.sid !== shareId) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;

  return payload;
}

/** owner token 只存哈希 */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** 恒定时间比较两个十六进制摘要 */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 从请求里取令牌：优先 Authorization 头，其次 ?t= */
export function extractToken(req, url) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const fromQuery = url?.searchParams?.get('t');
  return fromQuery ? fromQuery.trim() : null;
}
