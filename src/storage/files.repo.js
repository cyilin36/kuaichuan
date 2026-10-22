/**
 * files 表的读写。
 */

function toFile(row) {
  if (!row) return null;
  return {
    shareId: row.share_id,
    idx: row.idx,
    relPath: row.rel_path,
    name: row.name,
    size: row.size,
    mime: row.mime,
    storedPath: row.stored_path,
    state: row.state,
    receivedBytes: row.received_bytes ?? 0,
  };
}

export function insertFiles(db, shareId, files) {
  const stmt = db.prepare(
    `INSERT INTO files (share_id, idx, rel_path, name, size, mime, stored_path, state, received_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const file of files) {
    stmt.run(
      shareId,
      file.idx,
      file.relPath,
      file.name,
      file.size ?? 0,
      file.mime ?? '',
      file.storedPath ?? null,
      file.state ?? 'pending',
      file.receivedBytes ?? 0,
    );
  }
}

export function getFile(db, shareId, idx) {
  return toFile(
    db.prepare('SELECT * FROM files WHERE share_id = ? AND idx = ?').get(shareId, idx),
  );
}

export function listFiles(db, shareId) {
  return db.prepare('SELECT * FROM files WHERE share_id = ? ORDER BY idx ASC')
    .all(shareId)
    .map(toFile);
}

export function updateFile(db, shareId, idx, patch) {
  const sets = [];
  const params = [];
  if (patch.state !== undefined) { sets.push('state = ?'); params.push(String(patch.state)); }
  if (patch.size !== undefined) { sets.push('size = ?'); params.push(Number(patch.size)); }
  if (patch.storedPath !== undefined) {
    sets.push('stored_path = ?');
    params.push(patch.storedPath === null ? null : String(patch.storedPath));
  }
  if (patch.mime !== undefined) { sets.push('mime = ?'); params.push(String(patch.mime)); }
  if (patch.relPath !== undefined) { sets.push('rel_path = ?'); params.push(String(patch.relPath)); }
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(String(patch.name)); }
  if (patch.receivedBytes !== undefined) {
    sets.push('received_bytes = ?');
    params.push(Math.max(0, Number(patch.receivedBytes) || 0));
  }
  if (sets.length === 0) return false;

  params.push(shareId, idx);
  return db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE share_id = ? AND idx = ?`)
    .run(...params).changes > 0;
}

export function deleteFile(db, shareId, idx) {
  return db.prepare('DELETE FROM files WHERE share_id = ? AND idx = ?').run(shareId, idx).changes > 0;
}

/** 删除某个分享的全部文件记录 */
export function deleteFilesForShare(db, shareId) {
  return db.prepare('DELETE FROM files WHERE share_id = ?').run(shareId).changes;
}

export function listFilesByState(db, shareId, state) {
  return db.prepare('SELECT * FROM files WHERE share_id = ? AND state = ? ORDER BY idx ASC')
    .all(shareId, state)
    .map(toFile);
}

export function countFiles(db, shareId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM files WHERE share_id = ?').get(shareId);
  return Number(row?.n ?? 0);
}

export { toFile };
