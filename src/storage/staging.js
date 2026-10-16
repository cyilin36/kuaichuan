/**
 * 暂存文件的磁盘读写。
 *
 * 这里是「暂存模式」唯一写用户文件内容的地方：
 *   - 上传先写 <idx>.part，大小校验通过后原子 rename 成 <idx>.bin
 *   - 文件名永远由序号决定，用户提供的名字只进数据库，不进路径
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ensureShareDir } from '../paths.js';
import { payloadTooLarge } from '../errors.js';

/**
 * 把请求体流写入暂存文件。
 * @returns {Promise<{ size: number, path: string }>}
 */
export async function writeStagedFile({ locations, shareId, idx, stream, maxBytes = 0 }) {
  await ensureShareDir(locations, shareId);

  const partPath = locations.partFile(shareId, idx);
  const finalPath = locations.storedFile(shareId, idx);

  let written = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      if (maxBytes > 0 && written + chunk.length > maxBytes) {
        callback(payloadTooLarge(`单个文件不能超过 ${maxBytes} 字节`));
        return;
      }
      written += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, counter, createWriteStream(partPath, { mode: 0o600 }));
    await fsp.rename(partPath, finalPath);
    return { size: written, path: finalPath };
  } catch (err) {
    // 失败或中断都不能留残渣
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** 已落盘的暂存文件大小，不存在返回 null */
export async function statStagedFile(locations, shareId, idx) {
  try {
    const stat = await fsp.stat(locations.storedFile(shareId, idx));
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** 读取暂存文件（支持 Range） */
export function createStagedReadStream(locations, shareId, idx, range = {}) {
  const options = {};
  if (range.start !== undefined) options.start = range.start;
  if (range.end !== undefined) options.end = range.end;
  return createReadStream(locations.storedFile(shareId, idx), options);
}

/** 删除某个分享的全部暂存文件（幂等） */
export async function deleteShareFiles(locations, shareId) {
  const dir = locations.shareDir(shareId);
  await fsp.rm(dir, { recursive: true, force: true });
  return dir;
}

/** 递归统计目录占用，用于诊断（配额以数据库为准） */
export async function directoryUsage(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await directoryUsage(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) {
        bytes += stat.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

/** 磁盘上的暂存文件总览 */
export async function stagedDiskUsage(locations) {
  return directoryUsage(locations.filesDir);
}

/** 磁盘上存在目录的分享 ID 列表（用于孤儿目录清理） */
export async function listShareDirs(locations) {
  try {
    const entries = await fsp.readdir(locations.filesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
