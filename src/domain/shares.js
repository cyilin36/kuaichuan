/**
 * 分享领域服务：创建、读取、解锁、撤销与对外展示。
 *
 * 两条铁律在这里落地：
 *   1) P2P 分享（文件与文字）的内容一律不入库、不落盘，库里只有元数据
 *   2) 对外响应里绝不出现密码哈希、owner 哈希等敏感字段
 */

import { badRequest, forbidden, gone, notFound, unauthorized } from '../errors.js';
import { assertShareId, safeFileName, safeRelPath } from '../paths.js';
import { generatePassword, hashPassword, verifyPassword } from './passwords.js';
import { ACCESS_SCOPE, extractToken, hashToken, safeEqualHex, signToken, verifyToken } from './tokens.js';
import { generateUniqueShareId, randomString } from './ids.js';
import { getShare, insertShare, recordEvent, updateShare } from '../storage/shares.repo.js';
import { insertFiles, listFiles } from '../storage/files.repo.js';
import { revokeShare } from './lifecycle.js';

export const MAX_FILES_PER_SHARE = 500;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DOWNLOADS_LIMIT = 100_000;
export const OWNER_TOKEN_LENGTH = 32;

/** 校验并归一化一个访问来源（只保留 scheme + host + port） */
export function normalizeOrigin(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (value.length > 200) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function deriveFileTitle(files) {
  if (files.length === 1) return files[0].name;
  const firstDir = files[0].relPath.includes('/') ? `${files[0].relPath.split('/')[0]}/` : '';
  return `${firstDir}${files.length} 个文件`;
}

function deriveTextTitle(text) {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '一段文字';
  const trimmed = firstLine.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

export function createShareId(db) {
  return generateUniqueShareId((id) => Boolean(getShare(db, id)));
}

/**
 * 创建分享。
 * @returns {Promise<object>} 含一次性返回的明文密码与 ownerToken
 */
export async function createShare({ db, config, logger, input = {} }) {
  const kind = String(input.kind ?? '');
  if (kind !== 'file' && kind !== 'text') throw badRequest('kind 只能是 file 或 text');

  const mode = String(input.mode ?? '');
  if (mode !== 'p2p' && mode !== 'staged') throw badRequest('mode 只能是 p2p 或 staged');

  const ttlHours = input.ttlHours === undefined || input.ttlHours === null || input.ttlHours === ''
    ? config.defaultTtlHours
    : Number(input.ttlHours);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > config.maxTtlHours) {
    throw badRequest(`有效期需在 1 ~ ${config.maxTtlHours} 小时之间`);
  }

  let maxDownloads = null;
  if (input.maxDownloads !== undefined && input.maxDownloads !== null && input.maxDownloads !== '') {
    maxDownloads = Number(input.maxDownloads);
    if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > MAX_DOWNLOADS_LIMIT) {
      throw badRequest(`下载次数上限需在 1 ~ ${MAX_DOWNLOADS_LIMIT} 之间`);
    }
  }

  const burnAfterRead = input.burnAfterRead === true;
  const usePassword = input.password === true;

  let files = [];
  let textContent = null;
  let textBytes = 0;
  let title;

  if (kind === 'file') {
    if (!Array.isArray(input.files) || input.files.length === 0) throw badRequest('至少需要一个文件');
    if (input.files.length > MAX_FILES_PER_SHARE) {
      throw badRequest(`单个分享最多 ${MAX_FILES_PER_SHARE} 个文件`);
    }

    files = input.files.map((file, idx) => {
      const relPath = safeRelPath(file?.relPath ?? file?.name ?? '');
      const size = Number(file?.size ?? 0);
      if (!Number.isInteger(size) || size < 0) throw badRequest('文件大小不合法');
      if (config.maxFileBytes > 0 && size > config.maxFileBytes) {
        throw badRequest(`单个文件不能超过 ${config.maxFileBytes} 字节`);
      }
      return {
        idx,
        relPath,
        name: safeFileName(file?.name ?? relPath),
        size,
        mime: String(file?.mime ?? '').slice(0, 200),
        state: 'pending',
      };
    });
    title = String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH) || deriveFileTitle(files);
  } else {
    const raw = input.text === undefined || input.text === null ? '' : String(input.text);
    if (raw.trim() === '') throw badRequest('文字内容不能为空');
    textBytes = Buffer.byteLength(raw, 'utf8');
    if (config.maxTextBytes > 0 && textBytes > config.maxTextBytes) {
      throw badRequest(`文字内容不能超过 ${config.maxTextBytes} 字节`);
    }
    // P2P 文本的内容绝不入库，只记字节数
    if (mode === 'staged') textContent = raw;
    title = String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH) || deriveTextTitle(raw);
  }

  const now = Date.now();
  const id = createShareId(db);
  const ownerToken = randomString(OWNER_TOKEN_LENGTH);

  let password = null;
  let passwordHash = null;
  let passwordSalt = null;
  if (usePassword) {
    password = generatePassword();
    const hashed = await hashPassword(password);
    passwordHash = hashed.hash;
    passwordSalt = hashed.salt;
  }

  const expiresAt = now + ttlHours * 3_600_000;
  const totalBytes = kind === 'file' ? files.reduce((sum, file) => sum + file.size, 0) : textBytes;

  insertShare(db, {
    id,
    kind,
    mode,
    title,
    status: 'waiting',
    passwordHash,
    passwordSalt,
    ownerHash: hashToken(ownerToken),
    textContent,
    totalBytes,
    downloads: 0,
    maxDownloads,
    burnAfterRead,
    createdAt: now,
    expiresAt,
    lastAccessAt: null,
    revokedAt: null,
  });

  if (files.length > 0) insertFiles(db, id, files);
  recordEvent(db, 'create', { shareId: id });

  logger?.info('已创建分享', {
    id, kind, mode, files: files.length, password: usePassword, ttlHours, burn: burnAfterRead,
  });

  return {
    id,
    kind,
    mode,
    title,
    ttlHours,
    expiresAt,
    requiresPassword: usePassword,
    password,
    ownerToken,
    maxDownloads,
    burnAfterRead,
    totalBytes,
    files: files.map((file) => ({
      idx: file.idx, relPath: file.relPath, name: file.name, size: file.size, mime: file.mime,
    })),
  };
}

/** 取分享记录，ID 非法返回 400、不存在返回 404 */
export function getShareRow(db, id) {
  assertShareId(id);
  const share = getShare(db, id);
  if (!share) throw notFound();
  return share;
}

/** 校验分享当前是否可用 */
export function assertShareAvailable(share, now = Date.now()) {
  if (!share) throw notFound();
  if (share.revokedAt !== null && share.revokedAt !== undefined) throw gone('分享已被撤销');
  if (share.status === 'revoked') throw gone('分享已被撤销');
  if (share.status === 'expired') throw gone('分享已过期');
  if (share.expiresAt <= now) throw gone('分享已过期');
  if (share.maxDownloads !== null && share.downloads >= share.maxDownloads) {
    throw gone('分享的可下载次数已用尽');
  }
  return share;
}

/**
 * 判断请求者的身份。
 * @returns {{ role: 'owner' | 'access' } | null}
 */
export function resolveViewer({ tokenSecret, share, token, now = Date.now() }) {
  if (!token) return null;

  if (share.ownerHash && safeEqualHex(hashToken(token), share.ownerHash)) {
    return { role: 'owner' };
  }

  const payload = verifyToken({
    secret: tokenSecret,
    token,
    shareId: share.id,
    scope: ACCESS_SCOPE,
    now,
  });
  return payload ? { role: 'access' } : null;
}

/** 必须已解锁（或无密码分享已换取令牌），否则 401 */
export function requireViewer({ tokenSecret, share, token, now = Date.now() }) {
  const viewer = resolveViewer({ tokenSecret, share, token, now });
  if (!viewer) throw unauthorized('请先输入密码或重新打开分享链接');
  return viewer;
}

/**
 * 解锁：校验密码并签发 access token。
 * 无密码分享传空密码也直接签发（前端统一走这一步）。
 */
export async function unlockShare({ db, config, tokenSecret, share, password, now = Date.now() }) {
  if (share.passwordHash) {
    const ok = await verifyPassword(password, { hash: share.passwordHash, salt: share.passwordSalt });
    if (!ok) {
      recordEvent(db, 'unlock_fail', { shareId: share.id });
      throw forbidden('密码错误');
    }
  }

  const accessToken = signToken({
    secret: tokenSecret,
    shareId: share.id,
    scope: ACCESS_SCOPE,
    ttlSeconds: config.accessTokenTtlSeconds,
    now,
  });

  recordEvent(db, 'unlock_ok', { shareId: share.id });
  updateShare(db, share.id, { lastAccessAt: now });

  return { accessToken, expiresIn: config.accessTokenTtlSeconds };
}

/** 撤销（仅 owner） */
export async function revokeByOwner({ db, locations, share, now = Date.now() }) {
  if (share.revokedAt) return { alreadyRevoked: true };
  await revokeShare({ db, locations, id: share.id, now });
  return { alreadyRevoked: false };
}

/** 对外可见的分享信息（绝不包含哈希，也不直接带文字内容） */
export function publicMetadata({ share, files, role, senderOnline = null, now = Date.now() }) {
  void now;
  const isText = share.kind === 'text';
  const textIsStaged = isText && share.mode === 'staged';

  return {
    id: share.id,
    kind: share.kind,
    mode: share.mode,
    title: share.title,
    status: share.status,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    downloads: share.downloads,
    maxDownloads: share.maxDownloads,
    downloadsLeft: share.maxDownloads === null ? null : Math.max(0, share.maxDownloads - share.downloads),
    burnAfterRead: share.burnAfterRead,
    totalBytes: share.totalBytes,
    requiresPassword: Boolean(share.passwordHash),
    viewer: role ?? null,
    senderOnline: share.mode === 'p2p' ? senderOnline : null,
    // 文字内容统一走 GET /api/shares/:id/text 取件（计次与焚毁在那里处理）
    hasText: textIsStaged,
    textBytes: isText ? share.totalBytes : null,
    files: (files ?? []).map((file) => ({
      idx: file.idx,
      relPath: file.relPath,
      name: file.name,
      size: file.size,
      mime: file.mime,
      state: file.state,
    })),
  };
}

export function listShareFiles(db, shareId) {
  return listFiles(db, shareId);
}

export { extractToken };
