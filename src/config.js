/**
 * 配置：环境变量 -> 冻结的配置对象。
 * 所有默认值都在这里，README 的配置表与 .env.example 必须与本文件保持一致。
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, resolveDataDir, createLocations } from './paths.js';
import { configError } from './errors.js';

const pkg = createRequire(import.meta.url)('../package.json');

const DEFAULTS = {
  APP_NAME: '快传',
  PORT: '7654',
  HOST: '0.0.0.0',
  BASE_URL: '',
  DATA_DIR: './data',
  ALLOW_EXTERNAL_DATA_DIR: '0',
  DEFAULT_TTL_HOURS: '24',
  MAX_TTL_HOURS: '168',
  TTL_SWEEP_SECONDS: '60',
  MAX_FILE_BYTES: String(2 * 1024 ** 3),
  MAX_TEXT_BYTES: String(1024 * 1024),
  MAX_TOTAL_BYTES: String(20 * 1024 ** 3),
  RELAY_ENABLED: '1',
  RELAY_WAIT_SECONDS: '120',
  RELAY_MAX_SESSIONS: '8',
  STUN_URLS: 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302',
  TOKEN_SECRET: '',
  ACCESS_TOKEN_TTL_SECONDS: '7200',
  OWNER_TOKEN_TTL_SECONDS: '2592000',
  LOG_LEVEL: 'info',
  LOG_FILE: '',
};

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** 环境变量是否根本没提供（区别于「提供了空字符串」） */
function isUnset(env, key) {
  const raw = env[key];
  return raw === undefined || raw === null;
}

function readString(env, key) {
  if (isUnset(env, key)) return DEFAULTS[key];
  const raw = String(env[key]).trim();
  return raw === '' ? DEFAULTS[key] : raw;
}

function readInt(env, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = readString(env, key);
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw configError(`配置项 ${key} 必须是整数，当前值：${raw}`);
  }
  if (value < min || value > max) {
    throw configError(`配置项 ${key} 必须在 ${min} ~ ${max} 之间，当前值：${value}`);
  }
  return value;
}

function readBool(env, key) {
  const raw = readString(env, key).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(raw)) return false;
  throw configError(`配置项 ${key} 必须是布尔值（1/0、true/false），当前值：${raw}`);
}

/** 列表型配置：未设置时用默认值；显式设为空串表示「清空」 */
function readList(env, key) {
  const source = isUnset(env, key) ? DEFAULTS[key] : String(env[key]);
  return source
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const allowExternalDataDir = readBool(env, 'ALLOW_EXTERNAL_DATA_DIR');
  const dataDir = resolveDataDir(readString(env, 'DATA_DIR'), { allowExternal: allowExternalDataDir });
  const locations = createLocations(dataDir);

  const defaultTtlHours = readInt(env, 'DEFAULT_TTL_HOURS', { min: 1, max: 8760 });
  const maxTtlHours = readInt(env, 'MAX_TTL_HOURS', { min: 1, max: 8760 });
  if (maxTtlHours < defaultTtlHours) {
    throw configError('MAX_TTL_HOURS 不能小于 DEFAULT_TTL_HOURS');
  }

  const logLevel = readString(env, 'LOG_LEVEL').toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) {
    throw configError(`LOG_LEVEL 必须是 ${[...LOG_LEVELS].join(' / ')} 之一`);
  }

  const baseUrlRaw = readString(env, 'BASE_URL').replace(/\/+$/, '');
  if (baseUrlRaw !== '' && !/^https?:\/\/[^\s]+$/.test(baseUrlRaw)) {
    throw configError('BASE_URL 必须是 http(s):// 开头的地址，或留空');
  }

  return Object.freeze({
    appName: readString(env, 'APP_NAME'),
    version: pkg.version,
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),

    port: readInt(env, 'PORT', { min: 0, max: 65535 }),
    host: readString(env, 'HOST'),
    baseUrl: baseUrlRaw,

    dataDir,
    allowExternalDataDir,
    locations,

    defaultTtlHours,
    maxTtlHours,
    sweepSeconds: readInt(env, 'TTL_SWEEP_SECONDS', { min: 5, max: 86_400 }),

    maxFileBytes: readInt(env, 'MAX_FILE_BYTES', { min: 0 }),
    maxTextBytes: readInt(env, 'MAX_TEXT_BYTES', { min: 0 }),
    maxTotalBytes: readInt(env, 'MAX_TOTAL_BYTES', { min: 0 }),

    relayEnabled: readBool(env, 'RELAY_ENABLED'),
    relayWaitSeconds: readInt(env, 'RELAY_WAIT_SECONDS', { min: 5, max: 3600 }),
    relayMaxSessions: readInt(env, 'RELAY_MAX_SESSIONS', { min: 1, max: 256 }),
    stunUrls: readList(env, 'STUN_URLS'),

    tokenSecret: readString(env, 'TOKEN_SECRET'),
    accessTokenTtlSeconds: readInt(env, 'ACCESS_TOKEN_TTL_SECONDS', { min: 60, max: 31_536_000 }),
    ownerTokenTtlSeconds: readInt(env, 'OWNER_TOKEN_TTL_SECONDS', { min: 60, max: 315_360_000 }),

    logLevel,
    logFile: readString(env, 'LOG_FILE'),
  });
}

export { DEFAULTS };
