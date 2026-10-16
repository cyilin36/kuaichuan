/**
 * shares 与 events 两张表的读写。
 *
 * 约定：对外返回 camelCase 对象，内部列名保持 snake_case。
 */

const SHARE_COLUMNS = [
  'id', 'kind', 'mode', 'title', 'status', 'base_url',
  'password_hash', 'password_salt', 'owner_hash', 'text_content',
  'total_bytes', 'downloads', 'max_downloads', 'burn_after_read',
  'created_at', 'expires_at', 'last_access_at', 'revoked_at',
];

function toShare(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    title: row.title,
    status: row.status,
    baseUrl: row.base_url,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    ownerHash: row.owner_hash,
    textContent: row.text_content,
    totalBytes: row.total_bytes,
    downloads: row.downloads,
    maxDownloads: row.max_downloads,
    burnAfterRead: row.burn_after_read === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastAccessAt: row.last_access_at,
    revokedAt: row.revoked_at,
  };
}

/** 允许通过 updateShare 修改的字段白名单：camelCase -> [列名, 归一化函数] */
const UPDATABLE = {
  title: ['title', String],
  status: ['status', String],
  baseUrl: ['base_url', String],
  textContent: ['text_content', (v) => (v === null || v === undefined ? null : String(v))],
  totalBytes: ['total_bytes', Number],
  downloads: ['downloads', Number],
  maxDownloads: ['max_downloads', (v) => (v === null || v === undefined ? null : Number(v))],
  burnAfterRead: ['burn_after_read', (v) => (v ? 1 : 0)],
  lastAccessAt: ['last_access_at', (v) => (v === null || v === undefined ? null : Number(v))],
  expiresAt: ['expires_at', Number],
  revokedAt: ['revoked_at', (v) => (v === null || v === undefined ? null : Number(v))],
  passwordHash: ['password_hash', (v) => (v === null || v === undefined ? null : String(v))],
  passwordSalt: ['password_salt', (v) => (v === null || v === undefined ? null : String(v))],
  ownerHash: ['owner_hash', String],
};

export function insertShare(db, share) {
  const values = SHARE_COLUMNS.map((col) => {
    switch (col) {
      case 'password_hash': return share.passwordHash ?? null;
      case 'password_salt': return share.passwordSalt ?? null;
      case 'text_content': return share.textContent ?? null;
      case 'max_downloads': return share.maxDownloads ?? null;
      case 'last_access_at': return share.lastAccessAt ?? null;
      case 'revoked_at': return share.revokedAt ?? null;
      case 'burn_after_read': return share.burnAfterRead ? 1 : 0;
      case 'base_url': return share.baseUrl ?? '';
      case 'title': return share.title ?? '';
      case 'total_bytes': return share.totalBytes ?? 0;
      case 'downloads': return share.downloads ?? 0;
      default: return share[toCamel(col)];
    }
  });

  db.prepare(
    `INSERT INTO shares (${SHARE_COLUMNS.join(', ')})
     VALUES (${SHARE_COLUMNS.map(() => '?').join(', ')})`,
  ).run(...values);
}

export function getShare(db, id) {
  const row = db.prepare(`SELECT ${SHARE_COLUMNS.join(', ')} FROM shares WHERE id = ?`).get(id);
  return toShare(row);
}

export function updateShare(db, id, patch) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    const spec = UPDATABLE[key];
    if (!spec) throw new Error(`不允许更新的字段：${key}`);
    sets.push(`${spec[0]} = ?`);
    params.push(spec[1](value));
  }
  if (sets.length === 0) return false;
  params.push(id);
  const result = db.prepare(`UPDATE shares SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

export function deleteShare(db, id) {
  return db.prepare('DELETE FROM shares WHERE id = ?').run(id).changes > 0;
}

/** 过期的分享（含 P2P：P2P 过期只是链接失效，没有磁盘文件） */
export function listExpired(db, now, limit = 500) {
  return db.prepare(
    `SELECT id, mode FROM shares
     WHERE expires_at <= ? AND status != 'expired' AND status != 'revoked'
     ORDER BY expires_at ASC LIMIT ?`,
  ).all(now, limit);
}

/** 已过期、且已过宽限期的记录（可以彻底删除） */
export function listExpiredBefore(db, cutoff, limit = 500) {
  return db.prepare(
    `SELECT id FROM shares
     WHERE status = 'expired' AND expires_at <= ?
     ORDER BY expires_at ASC LIMIT ?`,
  ).all(cutoff, limit);
}

/** 已撤销、且撤销时间早于某个时刻的分享（留一点时间给页面展示「已撤销」） */
export function listRevokedBefore(db, cutoff, limit = 500) {
  return db.prepare(
    `SELECT id, mode FROM shares
     WHERE revoked_at IS NOT NULL AND revoked_at <= ?
     ORDER BY revoked_at ASC LIMIT ?`,
  ).all(cutoff, limit);
}

/** 暂存类分享按创建时间从旧到新（配额清理用） */
export function listStagedOldest(db, limit = 1000) {
  return db.prepare(
    `SELECT id, created_at, total_bytes FROM shares
     WHERE mode = 'staged' AND status != 'revoked' AND revoked_at IS NULL
     ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).all(limit);
}

/** 暂存占用（只统计已上传完成的文件字节） */
export function stagedUsage(db) {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT s.id) AS shares, COALESCE(SUM(f.size), 0) AS bytes
     FROM shares s
     JOIN files f ON f.share_id = s.id
     WHERE s.mode = 'staged' AND f.state = 'uploaded'`,
  ).get();
  return { shares: Number(row?.shares ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export function countShares(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM shares').get();
  return Number(row?.n ?? 0);
}

export function incrementDownloads(db, id) {
  db.prepare('UPDATE shares SET downloads = downloads + 1, last_access_at = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function touchAccess(db, id, at = Date.now()) {
  db.prepare('UPDATE shares SET last_access_at = ? WHERE id = ?').run(at, id);
}

export function recordEvent(db, type, { shareId = null, ipHash = null, at = Date.now() } = {}) {
  db.prepare('INSERT INTO events (share_id, type, ip_hash, at) VALUES (?, ?, ?, ?)')
    .run(shareId, type, ipHash, at);
}

export function listEvents(db, shareId, limit = 100) {
  return db.prepare(
    'SELECT id, type, ip_hash, at FROM events WHERE share_id = ? ORDER BY at DESC LIMIT ?',
  ).all(shareId, limit).map((row) => ({
    id: row.id, type: row.type, ipHash: row.ip_hash, at: row.at,
  }));
}

export function pruneEvents(db, before) {
  return db.prepare('DELETE FROM events WHERE at < ?').run(before).changes;
}

function toCamel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export { SHARE_COLUMNS, toShare };
