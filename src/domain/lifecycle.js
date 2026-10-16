/**
 * 分享的删除与生命周期编排。
 *
 * 规则：删除必须同时清「数据库记录」与「data/files/<id>/」，只删一半算缺陷。
 * P2P 分享没有磁盘文件，删目录是幂等的空操作。
 */

import {
  deleteShare as repoDeleteShare,
  listExpired,
  listExpiredBefore,
  listRevokedBefore,
  listStagedOldest,
  stagedUsage,
  updateShare,
  recordEvent,
} from '../storage/shares.repo.js';
import { deleteFilesForShare } from '../storage/files.repo.js';
import { deleteShareFiles, listShareDirs } from '../storage/staging.js';
import { selectEvictions } from './quota.js';
import { insufficientStorage } from '../errors.js';

/** 过期后记录保留多久：让链接返回「已失效」而不是「不存在」 */
export const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;
/** 撤销后记录保留多久 */
export const REVOKED_GRACE_MS = 60 * 60 * 1000;
/** 审计事件保留多久 */
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 彻底删除分享：先删磁盘，再删记录 */
export async function purgeShare({ db, locations, id, reason = 'purge' }) {
  recordEvent(db, reason, { shareId: id });
  await deleteShareFiles(locations, id);
  return repoDeleteShare(db, id);
}

/** 撤销：立刻释放磁盘，记录留一小段时间 */
export async function revokeShare({ db, locations, id, now = Date.now() }) {
  await deleteShareFiles(locations, id);
  deleteFilesForShare(db, id);
  updateShare(db, id, { status: 'revoked', revokedAt: now, totalBytes: 0, textContent: null });
  recordEvent(db, 'revoke', { shareId: id });
}

/**
 * 过期扫描：释放磁盘 + 标记 expired（记录留宽限期）。
 * 文本分享同时清空内容，避免过期内容继续留在库里。
 */
export async function expireDue({ db, locations, logger, now = Date.now(), limit = 500 }) {
  const due = listExpired(db, now, limit);
  for (const row of due) {
    await deleteShareFiles(locations, row.id);
    deleteFilesForShare(db, row.id);
    updateShare(db, row.id, { status: 'expired', totalBytes: 0, textContent: null });
    recordEvent(db, 'expire', { shareId: row.id });
  }
  if (due.length > 0) logger?.info('已处理过期分享', { count: due.length });
  return due.length;
}

/** 彻底清理过期的记录 */
export function purgeExpired({ db, now = Date.now(), graceMs = EXPIRED_GRACE_MS, limit = 500 }) {
  const rows = listExpiredBefore(db, now - graceMs, limit);
  for (const row of rows) repoDeleteShare(db, row.id);
  return rows.length;
}

/** 彻底清理已撤销的记录 */
export function purgeRevoked({ db, now = Date.now(), graceMs = REVOKED_GRACE_MS, limit = 500 }) {
  const rows = listRevokedBefore(db, now - graceMs, limit);
  for (const row of rows) repoDeleteShare(db, row.id);
  return rows.length;
}

/**
 * 暂存配额：超出总量时按创建时间从旧到新删除暂存分享；仍不够则拒绝。
 * @returns {Promise<{ evicted: string[] }>}
 */
export async function enforceQuota({
  db,
  locations,
  logger,
  incomingBytes = 0,
  maxTotalBytes = 0,
  protectIds = [],
}) {
  if (maxTotalBytes <= 0) return { evicted: [] };

  const { bytes } = stagedUsage(db);
  if (bytes + incomingBytes <= maxTotalBytes) return { evicted: [] };

  const rows = listStagedOldest(db);
  const { evict, feasible } = selectEvictions(rows, {
    incomingBytes,
    maxTotalBytes,
    usedBytes: bytes,
    protect: new Set(protectIds),
  });

  for (const id of evict) {
    logger?.info('暂存配额不足，清理最旧的分享', { id });
    await purgeShare({ db, locations, id, reason: 'quota_evict' });
  }

  if (!feasible) {
    throw insufficientStorage('服务器暂存空间不足，请稍后再试，或调大 MAX_TOTAL_BYTES');
  }
  return { evicted: evict };
}

/** 磁盘上残留的孤儿目录（数据库里已经没有对应分享） */
export async function purgeOrphanDirs({ db, locations, logger }) {
  const dirs = await listShareDirs(locations);
  const removed = [];
  for (const id of dirs) {
    const exists = db.prepare('SELECT 1 AS ok FROM shares WHERE id = ?').get(id);
    if (!exists) {
      await deleteShareFiles(locations, id);
      removed.push(id);
    }
  }
  if (removed.length > 0) logger?.warn('清理了孤儿暂存目录', { count: removed.length });
  return removed;
}

/** /healthz 用的暂存统计 */
export function stats(db) {
  return stagedUsage(db);
}
