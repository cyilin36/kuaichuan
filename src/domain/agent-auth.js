/**
 * AI Agent 接口的 API Key 校验。
 *
 * 默认（AGENT_API_KEYS 为空）与网页端一致，不额外鉴权；
 * 一旦配置了 Key，只接受 Authorization: Bearer <key>。
 * 日志与错误信息里绝不出现 Key 本身。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { configError, notFound, unauthorized } from '../errors.js';

/** 从请求头取 Bearer 令牌；没有则返回 null */
export function parseBearer(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Key 只以摘要形式存在内存里，比较时也不还原明文 */
export function hashApiKey(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex');
}

/**
 * @param {{ agentEnabled: boolean, agentApiKeys: string[] }} config
 * @returns {(req: import('node:http').IncomingMessage) => { method: 'none' | 'api-key' }}
 */
export function createAgentAuth({ agentEnabled, agentApiKeys }) {
  if (agentEnabled && agentApiKeys.length > 0) {
    for (const key of agentApiKeys) {
      if (typeof key !== 'string' || key.trim() === '') {
        throw configError('AGENT_API_KEYS 不能包含空 Key');
      }
    }
  }

  const hashes = agentApiKeys.map((key) => Buffer.from(hashApiKey(key), 'hex'));

  return function requireAgent(req) {
    if (!agentEnabled) {
      // 与「接口不存在」保持一致的对外语义，不暴露功能开关
      throw notFound('AI 接入未启用');
    }
    if (hashes.length === 0) return { method: 'none' };

    const token = parseBearer(req);
    if (!token) throw unauthorized('缺少 API Key');

    const given = Buffer.from(hashApiKey(token), 'hex');
    let matched = false;
    for (const expected of hashes) {
      // 恒定时间比较；遍历全部 Key，不因命中提前返回
      if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
    }
    if (!matched) throw unauthorized('API Key 无效');
    return { method: 'api-key' };
  };
}
