/**
 * SQLite 连接（Node 内置 node:sqlite，无需第三方依赖）。
 */

import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

/**
 * 打开数据库并完成迁移。
 * @param {{ dbFile: string }} locations
 */
export function openDatabase(locations, { logger } = {}) {
  const db = new DatabaseSync(locations.dbFile);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  const version = migrate(db, logger);
  logger?.debug('数据库已就绪', { version, file: locations.dbFile });

  return db;
}

/** 关闭数据库（测试与优雅退出用） */
export function closeDatabase(db) {
  try {
    db.close();
  } catch {
    // 已关闭则忽略
  }
}

/** 在事务中执行；回调抛错则整体回滚 */
export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败不掩盖原始错误
    }
    throw err;
  }
}
