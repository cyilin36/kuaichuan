/**
 * 令牌签名密钥。
 *
 * 优先用 TOKEN_SECRET；没有就首次启动生成一个并保存到 <DATA_DIR>/secret.key（0600）。
 * 密钥文件写在数据目录内，不会跑到项目外面去。
 */

import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';

/**
 * @param {{ tokenSecret: string, locations: { secretFile: string } }} config
 * @returns {Promise<Buffer>}
 */
export async function loadTokenSecret(config) {
  if (config.tokenSecret) return Buffer.from(config.tokenSecret, 'utf8');

  const file = config.locations.secretFile;

  const existing = await readSecretFile(file);
  if (existing) return existing;

  const generated = randomBytes(32).toString('base64url');
  try {
    await fsp.writeFile(file, `${generated}\n`, { mode: 0o600, flag: 'wx' });
    return Buffer.from(generated, 'utf8');
  } catch (err) {
    if (err?.code === 'EEXIST') {
      // 并发启动：以先写入的为准
      const raced = await readSecretFile(file);
      if (raced) return raced;
    }
    throw err;
  }
}

async function readSecretFile(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : Buffer.from(trimmed, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** 收紧权限（某些文件系统 umask 会放宽） */
export async function hardenSecretFile(file) {
  await fsp.chmod(file, 0o600).catch(() => {});
}
