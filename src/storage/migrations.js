/**
 * 数据库结构迁移。
 *
 * 规则：只追加迁移，不改历史迁移；每个迁移在一个事务里完成。
 */

const MIGRATIONS = [
  {
    version: 1,
    up: `
      CREATE TABLE shares (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('file', 'text')),
        mode            TEXT NOT NULL CHECK (mode IN ('p2p', 'staged')),
        title           TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'waiting'
                          CHECK (status IN ('waiting', 'active', 'completed', 'expired', 'revoked')),
        base_url        TEXT NOT NULL DEFAULT '',
        password_hash   TEXT,
        password_salt   TEXT,
        owner_hash      TEXT NOT NULL,
        text_content    TEXT,
        total_bytes     INTEGER NOT NULL DEFAULT 0,
        downloads       INTEGER NOT NULL DEFAULT 0,
        max_downloads   INTEGER,
        burn_after_read INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        last_access_at  INTEGER,
        revoked_at      INTEGER
      );

      CREATE INDEX idx_shares_expires ON shares (expires_at);
      CREATE INDEX idx_shares_created ON shares (created_at);
      CREATE INDEX idx_shares_mode ON shares (mode, created_at);

      CREATE TABLE files (
        share_id    TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
        idx         INTEGER NOT NULL,
        rel_path    TEXT NOT NULL,
        name        TEXT NOT NULL,
        size        INTEGER NOT NULL DEFAULT 0,
        mime        TEXT NOT NULL DEFAULT '',
        stored_path TEXT,
        state       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'uploading', 'uploaded', 'consumed')),
        PRIMARY KEY (share_id, idx)
      );

      CREATE INDEX idx_files_state ON files (state);

      CREATE TABLE events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id TEXT,
        type     TEXT NOT NULL,
        ip_hash  TEXT,
        at       INTEGER NOT NULL
      );

      CREATE INDEX idx_events_share ON events (share_id, at);
      CREATE INDEX idx_events_at ON events (at);
    `,
  },
  {
    // 分享链接由前端按浏览器当前地址拼接，服务端不再需要、也不再保存固定地址。
    version: 2,
    up: `
      ALTER TABLE shares DROP COLUMN base_url;
    `,
  },
  {
    // 断点续传：记录未完成分片已落盘的字节数，让配额统计也能覆盖 .part。
    version: 3,
    up: `
      ALTER TABLE files ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} 迁移后的版本号
 */
export function migrate(db, logger) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  let current = row ? Number(row.value) : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run('schema_version', String(migration.version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    logger?.info('已应用数据库迁移', { version: migration.version });
    current = migration.version;
  }

  return current;
}

export { MIGRATIONS };
