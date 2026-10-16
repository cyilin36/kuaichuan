/**
 * 短 ID 与随机串生成。
 *
 * 分享 ID 用 6 位 base62（区分大小写），空间约 5.7e10，配合密码使用足够。
 */

import { randomInt } from 'node:crypto';
import { AppError } from '../errors.js';

export const ALPHABET_BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const SHARE_ID_LENGTH = 6;

/** 从给定字母表里取密码学安全的随机串 */
export function randomString(length, alphabet = ALPHABET_BASE62) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

export function generateShareId() {
  return randomString(SHARE_ID_LENGTH);
}

/**
 * 生成一个库里不存在的分享 ID。
 * @param {(id: string) => boolean} exists
 */
export function generateUniqueShareId(exists) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = generateShareId();
    if (!exists(id)) return id;
  }
  throw new AppError('id_exhausted', 500, '生成分享 ID 失败，请稍后重试');
}

/** 6 位 base62 */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9]{6}$/;
