/**
 * 路径唯一入口。
 *
 * 项目里任何涉及磁盘位置的代码都必须经过本模块，禁止在别处拼接路径：
 * 这是「所有文件只能落在本项目目录内」这条硬规则的执行点。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { badRequest } from './errors.js';

/** 项目根目录（AGENTS.md 所在目录，也是 git 仓库根） */
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 是否在 base 目录内（含 base 自身） */
export function isContained(base, target) {
  const baseAbs = path.resolve(base);
  const targetAbs = path.resolve(target);
  const rel = path.relative(baseAbs, targetAbs);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** 断言 target 在 base 内，否则抛 400 */
export function assertContained(base, target, label = '路径') {
  const abs = path.resolve(target);
  if (!isContained(base, abs)) throw badRequest(`${label}越出允许范围`);
  return abs;
}

/** 相对项目根解析并断言仍在项目内 */
export function resolveFromRoot(...segments) {
  return assertContained(ROOT, path.resolve(ROOT, ...segments), '路径');
}

/**
 * 解析数据目录。
 * 默认必须落在项目目录内；Docker 挂载卷场景需显式设置 ALLOW_EXTERNAL_DATA_DIR=1。
 */
export function resolveDataDir(rawDir, { allowExternal = false } = {}) {
  const raw = rawDir === undefined || rawDir === null || String(rawDir).trim() === ''
    ? './data'
    : String(rawDir).trim();
  const abs = path.resolve(ROOT, raw);
  if (!allowExternal) assertContained(ROOT, abs, 'DATA_DIR');
  return abs;
}

/** 分享 ID：6 位 base62（允许 4~32 位以便将来调整） */
export function assertShareId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{4,32}$/.test(id)) {
    throw badRequest('分享 ID 非法');
  }
  return id;
}

/** 文件序号 */
export function assertIndex(idx) {
  const n = typeof idx === 'number' ? idx : Number.parseInt(String(idx), 10);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw badRequest('文件序号非法');
  return n;
}

/** 集中定义所有落盘位置 */
export function createLocations(dataDir) {
  const dataDirAbs = path.resolve(dataDir);
  const filesDir = path.join(dataDirAbs, 'files');
  const logsDir = path.join(dataDirAbs, 'logs');

  return {
    dataDir: dataDirAbs,
    dbFile: path.join(dataDirAbs, 'share.db'),
    secretFile: path.join(dataDirAbs, 'secret.key'),
    filesDir,
    tmpDir: path.join(dataDirAbs, 'tmp'),
    logsDir,
    /** 某个分享的暂存目录 */
    shareDir(id) {
      const dir = path.join(filesDir, assertShareId(id));
      if (!isContained(filesDir, dir)) throw badRequest('分享目录非法');
      return dir;
    },
    /** 某个暂存文件的最终路径（文件名由序号决定，绝不使用用户提供的文件名） */
    storedFile(id, idx) {
      return path.join(filesDir, assertShareId(id), `${assertIndex(idx)}.bin`);
    },
    /** 上传中的临时文件（写完后原子 rename） */
    partFile(id, idx) {
      return path.join(filesDir, assertShareId(id), `${assertIndex(idx)}.part`);
    },
    /** 日志文件（限制在 logs 目录内） */
    logFile(name) {
      const target = path.resolve(logsDir, String(name));
      if (!isContained(logsDir, target)) throw badRequest('LOG_FILE 必须位于数据目录的 logs 子目录内');
      return target;
    },
  };
}

/** 创建数据目录结构（幂等） */
export async function ensureDirs(locations) {
  for (const dir of [locations.dataDir, locations.filesDir, locations.tmpDir, locations.logsDir]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

/**
 * 创建并校验某个分享的暂存目录。
 * 额外做一次 realpath 校验：防止有人在 files/ 里放符号链接把写入引到项目外。
 */
export async function ensureShareDir(locations, id) {
  const dir = locations.shareDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const [realFiles, realDir] = await Promise.all([
    fsp.realpath(locations.filesDir),
    fsp.realpath(dir),
  ]);
  if (!isContained(realFiles, realDir)) throw badRequest('分享目录越出数据目录');
  return dir;
}

/**
 * 把浏览器传来的相对路径（webkitRelativePath）净化成**仅用于展示与记录**的标签。
 * 它绝不会被拼进磁盘路径。
 */
export function safeRelPath(input) {
  const raw = String(input ?? '').replace(/\\/g, '/');
  if (raw === '') throw badRequest('文件相对路径为空');
  if (raw.startsWith('/')) throw badRequest('文件相对路径非法');
  if (/^[A-Za-z]:/.test(raw)) throw badRequest('文件相对路径非法');

  const parts = [];
  for (const seg of raw.split('/')) {
    const s = seg.trim();
    if (s === '' || s === '.') continue;
    if (s === '..') throw badRequest('文件相对路径非法');
    // 控制字符 / NUL / 分隔符残留
    if (/[\u0000-\u001f\u007f]/.test(s)) throw badRequest('文件相对路径含非法字符');
    parts.push(s);
  }
  if (parts.length === 0) throw badRequest('文件相对路径为空');

  const joined = parts.join('/');
  if (joined.length > 512) throw badRequest('文件相对路径过长');
  return joined;
}

/** 把浏览器传来的文件名净化成安全的名字（只用于展示与响应头） */
export function safeFileName(input) {
  const raw = String(input ?? '').replace(/\\/g, '/');
  let name = path.posix.basename(raw);
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name === '' || name === '.' || name === '..') name = 'file';
  return name.slice(0, 200);
}

/** 相对路径的父目录（用于展示目录结构） */
export function relDirOf(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}
