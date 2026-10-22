#!/usr/bin/env node
/**
 * 容器入口脚本。
 *
 * 作用：容器以 root 启动时，先把数据目录的属主纠正为镜像内的 node 用户（uid 1000），
 * 然后立刻降权到 node 再启动真正的服务进程。这样长期运行的进程始终是非 root。
 *
 * 为什么要这样做：
 *   服务进程以非 root 运行，而 bind mount 的宿主机目录通常由 dockerd（root）创建，
 *   或者属于宿主机上的其他用户。容器内 uid 1000 没有写权限，启动时会 EACCES 崩溃。
 *   如果要求部署者在宿主机执行 sudo chown，就等于部署需要 sudo——这里的纠正让
 *   `docker compose up -d` 在任何情况下都不需要宿主机 sudo。
 *
 * 用 --user 指定非 root 用户运行（如 --user 1000:1000）时不做纠正——此时也没有权限，
 * 直接以该用户启动，前提是该用户对数据目录可写。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

/** 镜像内 node 用户的 uid / gid（与 Dockerfile 里 chown node:node 一致） */
export const RUN_UID = 1000;
export const RUN_GID = 1000;

/** 需要转发的信号：compose stop 默认发 SIGTERM */
const FORWARD_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** 需要检查属主的位置：与 ensureDirs 建的目录、启动时要写的数据文件对应 */
export function ownershipTargets(dataDir) {
  return [
    dataDir,
    path.join(dataDir, 'files'),
    path.join(dataDir, 'logs'),
    path.join(dataDir, 'tmp'),
    path.join(dataDir, 'share.db'),
    path.join(dataDir, 'share.db-wal'),
    path.join(dataDir, 'share.db-shm'),
    path.join(dataDir, 'secret.key'),
  ];
}

/** 从环境变量解析数据目录（与业务侧 DATA_DIR 同义） */
export function dataDirOf(env = process.env) {
  const raw = typeof env.DATA_DIR === 'string' ? env.DATA_DIR.trim() : '';
  return path.resolve(raw === '' ? '/data' : raw);
}

/**
 * 判断是否需要纠正属主。
 * 顶层目录不存在要纠正（容器内第一次挂空目录）；已存在的位置只要 uid/gid 不符就要纠正。
 */
export async function needsOwnershipFix(
  dataDir,
  { uid = RUN_UID, gid = RUN_GID, lstat = fsp.lstat } = {},
) {
  for (const target of ownershipTargets(dataDir)) {
    let st;
    try {
      st = await lstat(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (target === dataDir) return true;
      continue;
    }
    if (st.uid !== uid || st.gid !== gid) return true;
  }
  return false;
}

/**
 * 递归纠正属主：先子后父，使用 lchown 不跟随符号链接，
 * 避免有人把数据目录里的软链指向别处时被一并改动属主。
 */
export async function fixOwnership(
  dataDir,
  { uid = RUN_UID, gid = RUN_GID, lchown = fsp.lchown, readdir = fsp.readdir } = {},
) {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  for (const entry of entries) {
    const target = path.join(dataDir, entry.name);
    if (entry.isDirectory()) {
      await fixOwnership(target, { uid, gid, lchown, readdir });
    }
    if (entry.isSymbolicLink()) continue; // 不跟随，也不改软链目标
    await lchown(target, uid, gid);
  }
  try {
    await lchown(dataDir, uid, gid);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** 准备数据目录：确保存在，必要时纠正属主 */
async function prepareDataDir(dataDir) {
  await fsp.mkdir(dataDir, { recursive: true });
  if (!(await needsOwnershipFix(dataDir))) return;
  process.stderr.write(`[entrypoint] 数据目录属主不是 ${RUN_UID}:${RUN_GID}，正在修正：${dataDir}\n`);
  await fixOwnership(dataDir);
}

/** 降权到 node 用户；supplementary groups 也一并清掉，避免残留 root 组 */
export function dropPrivileges(uid = RUN_UID, gid = RUN_GID) {
  if (typeof process.setgroups === 'function') process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid);
}

/** 启动命令并转发信号，返回退出码 */
async function runCommand(argv) {
  const [command, ...args] = argv.length > 0 ? argv : ['node', 'src/server.js'];
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of FORWARD_SIGNALS) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // 子进程已退出，忽略
      }
    });
  }
  const [code] = await once(child, 'exit');
  return typeof code === 'number' ? code : 1;
}

async function main() {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    const dataDir = dataDirOf();
    await prepareDataDir(dataDir);
    dropPrivileges();
    if (process.getuid() !== RUN_UID) {
      throw new Error(`降权失败：当前 uid ${process.getuid()}，期望 ${RUN_UID}`);
    }
  }
  process.exitCode = await runCommand(process.argv.slice(2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`[entrypoint] 启动失败：${error?.message ?? error}\n`);
    process.exit(1);
  });
}
