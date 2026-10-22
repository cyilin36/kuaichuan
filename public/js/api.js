/**
 * 前端 API 封装与本机记录。
 *
 * - 访问令牌放 sessionStorage（短期有效）
 * - owner 令牌与分享记录放 localStorage，用于「我的分享」页面
 */

const ACCESS_PREFIX = 'kc.access.';
const SHARES_KEY = 'kc.shares';

export async function apiJson(path, { method = 'GET', body, token, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const error = new Error(data?.message ?? '操作失败，请稍后重试。');
    error.status = res.status;
    error.code = data?.error;
    throw error;
  }
  return data;
}

export async function loadPublicConfig() {
  try {
    return await apiJson('/api/config');
  } catch {
    return {
      appName: '快传',
      defaultTtlHours: 24,
      maxTtlHours: 168,
      maxP2pFileBytes: 0,
      maxStagedFileBytes: 2 * 1024 ** 3,
      maxTextBytes: 1024 * 1024,
      relayEnabled: true,
      passwordLength: 4,
    };
  }
}

export function saveAccessToken(shareId, token) {
  try {
    sessionStorage.setItem(`${ACCESS_PREFIX}${shareId}`, token);
  } catch {
    // 隐私模式下可能不可用，忽略
  }
}

export function getAccessToken(shareId) {
  try {
    return sessionStorage.getItem(`${ACCESS_PREFIX}${shareId}`);
  } catch {
    return null;
  }
}

export function listLocalShares() {
  try {
    const raw = localStorage.getItem(SHARES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocalShare(record) {
  const shares = listLocalShares().filter((item) => item.id !== record.id);
  shares.unshift(record);
  try {
    localStorage.setItem(SHARES_KEY, JSON.stringify(shares.slice(0, 200)));
  } catch {
    // 存不下就算了，不影响主流程
  }
}

export function removeLocalShare(shareId) {
  const shares = listLocalShares().filter((item) => item.id !== shareId);
  try {
    localStorage.setItem(SHARES_KEY, JSON.stringify(shares));
  } catch {
    // 忽略
  }
}

export function getLocalShare(shareId) {
  return listLocalShares().find((item) => item.id === shareId) ?? null;
}
