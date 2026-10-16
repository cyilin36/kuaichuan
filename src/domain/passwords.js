/**
 * 分享密码：固定 4 位、区分大小写的 [A-Za-z0-9]。
 *
 * 明文只在创建分享的响应里返回一次；库里只存 scrypt 哈希 + 随机盐。
 * 注意：按用户决定，密码校验**不做**失败次数限制与锁定。
 */

import { randomInt, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/** 大小写字母 + 数字，共 62 个字符 */
export const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const PASSWORD_LENGTH = 4;
export const PASSWORD_PATTERN = /^[A-Za-z0-9]{4}$/;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** 生成 4 位密码（密码学安全随机） */
export function generatePassword() {
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)];
  }
  return out;
}

/** @returns {Promise<{ hash: string, salt: string }>} */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString('base64url');
  const derived = await scrypt(String(password), salt, KEY_LENGTH);
  return { hash: Buffer.from(derived).toString('base64url'), salt };
}

/** 恒定时间比较；参数不完整一律返回 false */
export async function verifyPassword(password, { hash, salt } = {}) {
  if (typeof password !== 'string' || password === '') return false;
  if (typeof hash !== 'string' || typeof salt !== 'string' || hash === '' || salt === '') return false;

  let expected;
  let derived;
  try {
    expected = Buffer.from(hash, 'base64url');
    derived = Buffer.from(await scrypt(password, salt, KEY_LENGTH));
  } catch {
    return false;
  }
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}
