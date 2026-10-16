/**
 * 日志：JSON 行写 stdout（可选再落一份到 <DATA_DIR>/logs/）。
 *
 * 规矩：调用方不得把密码、token、query string、文件内容传进来；
 * 这里再做一层同名字段兜底遮蔽。
 */

import fs from 'node:fs';
import { createLocations } from './paths.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(password|passwd|pwd|token|secret|authorization|cookie|credential)/i;
const SECRET_URL = /([?&](?:t|token|k)=)[^&\s]*/gi;

function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(SECRET_URL, '$1[redacted]');
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * @param {{ level?: string, file?: string, locations?: ReturnType<typeof createLocations> }} options
 */
export function createLogger({ level = 'info', file = '', locations } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let stream = null;

  if (file) {
    if (!locations) throw new Error('写日志文件时必须提供 locations');
    stream = fs.createWriteStream(locations.logFile(file), { flags: 'a', mode: 0o600 });
  }

  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg: String(msg) };
    if (fields !== undefined) record.fields = redact(fields);
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: lvl, msg: record.msg, fields: '[unserializable]' });
    }
    process.stdout.write(`${line}\n`);
    if (stream) stream.write(`${line}\n`);
  };

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    close: () => {
      if (stream) stream.end();
    },
  };
}

/** 测试与工具用：直接构造一个 locations（默认数据目录） */
export { createLocations };
