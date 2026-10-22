/**
 * 暂存模式的文件上传与下载。
 *
 * PUT 上传：边写边校验大小，先 .part 再原子改名；支持 Upload-Offset 断点续传。
 *   暂停/中断保留 .part，显式停止（DELETE …/upload）才删除。
 * GET 下载：支持 Range 断点续传与 ETag/If-Range；成功后计次；阅后即焚的分享取走即删。
 */

import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { badRequest, conflict, forbidden, gone, notFound, payloadTooLarge } from '../../errors.js';
import { assertIndex } from '../../paths.js';
import { sendJson } from '../respond.js';
import { assertOctetStream, contentLength } from '../limits.js';
import { contentDisposition, fileEtag, ifRangeMatches, parseRange } from '../download.js';
import { parseUploadOffset, isClientAbort } from '../upload.js';
import { getFile, listFiles, deleteFile as deleteFileRow, updateFile } from '../../storage/files.repo.js';
import { incrementDownloads, recordEvent, updateShare } from '../../storage/shares.repo.js';
import {
  createStagedReadStream,
  deleteStagedPart,
  statStagedFile,
  statStagedPart,
  writeStagedFile,
} from '../../storage/staging.js';
import { assertShareAvailable, getShareRow, requireViewer } from '../../domain/shares.js';
import { extractToken } from '../../domain/tokens.js';
import { enforceQuota, purgeShare } from '../../domain/lifecycle.js';

/** 正在进行中的受限交付（阅后即焚 / 限次下载），避免同一个文件被并发取走两次 */
const activeDeliveries = new Set();

export function registerStagedRoutes(router, { config, logger, services }) {
  const { db, locations, tokenSecret } = services;

  /** 同一个文件的在途上传：req 用于停止时中止，done 用于等待它收尾 */
  const activeUploads = new Map();

  const uploadKey = (shareId, idx) => `${shareId}:${idx}`;

  /** 上传接口的公共校验：owner、分享可用、暂存文件、序号与记录都存在 */
  function loadUploadTarget({ params, req, url }) {
    const share = getShareRow(db, params.id);
    const viewer = requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    if (viewer.role !== 'owner') throw forbidden('只有分享的创建者可以上传文件');
    assertShareAvailable(share);

    if (share.kind !== 'file' || share.mode !== 'staged') {
      throw badRequest('该分享不是暂存文件分享，不能上传到服务器');
    }

    const idx = assertIndex(params.idx);
    const file = getFile(db, share.id, idx);
    if (!file) throw notFound('文件不存在');
    return { share, file, idx };
  }

  /** 上传完成后重算分享总量与是否全部完成 */
  function refreshShareAfterUpload(shareId) {
    const files = listFiles(db, shareId);
    const uploaded = files.filter((item) => item.state === 'uploaded');
    const totalBytes = uploaded.reduce((sum, item) => sum + item.size, 0);
    const allUploaded = files.length > 0 && uploaded.length === files.length;

    updateShare(db, shareId, {
      totalBytes,
      ...(allUploaded ? { status: 'active' } : {}),
    });

    return { files, uploaded, totalBytes, allUploaded };
  }

  // ---------------- 断点状态 ----------------

  router.get('/api/shares/:id/files/:idx/upload', async (req, res, { params, url }) => {
    const { share, file, idx } = loadUploadTarget({ params, req, url });

    let bin = await statStagedFile(locations, share.id, idx);
    if (file.state === 'uploaded' && !bin) {
      // 记录说已完成但磁盘文件不见了：退回未完成，允许重新上传
      updateFile(db, share.id, idx, { state: 'pending', receivedBytes: 0 });
    }

    if (bin) {
      if (file.state !== 'uploaded' || file.receivedBytes !== bin.size) {
        updateFile(db, share.id, idx, {
          state: 'uploaded',
          size: bin.size,
          receivedBytes: bin.size,
          storedPath: `${idx}.bin`,
        });
      }
      sendJson(res, 200, {
        ok: true,
        idx,
        size: file.size,
        received: bin.size,
        state: 'uploaded',
        complete: true,
      });
      return;
    }

    const part = await statStagedPart(locations, share.id, idx);
    let received = part?.size ?? 0;
    if (received > file.size) {
      // 异常分片不能作为续传起点
      await deleteStagedPart(locations, share.id, idx);
      received = 0;
    }
    if (file.receivedBytes !== received) {
      updateFile(db, share.id, idx, { receivedBytes: received });
    }

    sendJson(res, 200, {
      ok: true,
      idx,
      size: file.size,
      received,
      state: file.state,
      complete: false,
    });
  });

  // ---------------- 断点续传上传 ----------------

  router.put('/api/shares/:id/files/:idx', async (req, res, { params, url }) => {
    const { share, file, idx } = loadUploadTarget({ params, req, url });

    if (file.state === 'uploaded') throw conflict('该文件已上传完成，不能重复上传');
    assertOctetStream(req);

    const key = uploadKey(share.id, idx);
    if (activeUploads.has(key)) throw conflict('该文件正在上传中，请稍后再试');

    const requestedOffset = parseUploadOffset(req.headers['upload-offset']);
    const part = await statStagedPart(locations, share.id, idx);
    const partSize = part?.size ?? 0;

    let offset = requestedOffset;
    if (offset === null) {
      // 没有偏移量表示「从头开始」：清掉旧分片再写
      offset = 0;
      if (partSize > 0) await deleteStagedPart(locations, share.id, idx);
    } else if (offset !== partSize) {
      throw conflict('上传进度与服务器记录不一致，请从服务器记录的断点继续', {
        received: partSize,
      });
    }

    if (offset > file.size) {
      throw conflict('上传偏移量超过文件大小', { received: partSize, size: file.size });
    }

    // 让配额统计立刻包含已落盘分片
    updateFile(db, share.id, idx, { state: 'pending', receivedBytes: offset });

    const remaining = Math.max(0, file.size - offset);
    const declared = contentLength(req);
    if (declared !== null && declared > remaining) {
      await deleteStagedPart(locations, share.id, idx);
      updateFile(db, share.id, idx, { receivedBytes: 0 });
      throw payloadTooLarge(`文件内容超过创建时声明的大小 ${file.size} 字节`);
    }

    let release;
    const done = new Promise((resolve) => { release = resolve; });
    activeUploads.set(key, { req, done });

    try {
      await enforceQuota({
        db,
        locations,
        logger,
        incomingBytes: remaining,
        maxTotalBytes: config.maxTotalBytes,
        protectIds: [share.id],
      });

      let result;
      try {
        result = await writeStagedFile({
          locations,
          shareId: share.id,
          idx,
          stream: req,
          offset,
          expectedSize: file.size,
          maxBytes: config.maxFileBytes,
        });
      } catch (err) {
        // 中断/超限后以磁盘上真实残留为准，续传端点才可信
        const leftover = await statStagedPart(locations, share.id, idx).catch(() => null);
        const received = Math.min(file.size, leftover?.size ?? 0);
        updateFile(db, share.id, idx, { state: 'pending', receivedBytes: received });
        if (isClientAbort(err)) {
          // 暂停/取消/断网：分片保留，供下次续传
          logger?.debug('上传被客户端中断', { id: share.id, idx, received });
          return;
        }
        throw err;
      }

      if (!result.complete) {
        updateFile(db, share.id, idx, { state: 'pending', receivedBytes: result.size });
        logger?.info('暂存文件已收到部分内容', {
          id: share.id, idx, received: result.size, size: file.size,
        });
        sendJson(res, 202, {
          ok: true, idx, size: file.size, received: result.size, complete: false,
        });
        return;
      }

      updateFile(db, share.id, idx, {
        state: 'uploaded',
        size: result.size,
        receivedBytes: result.size,
        storedPath: `${idx}.bin`,
      });

      const refreshed = refreshShareAfterUpload(share.id);
      recordEvent(db, 'upload', { shareId: share.id });
      logger?.info('暂存文件已上传', {
        id: share.id, idx, size: result.size, allUploaded: refreshed.allUploaded,
      });

      sendJson(res, 200, {
        ok: true,
        idx,
        size: result.size,
        received: result.size,
        complete: true,
        uploaded: refreshed.uploaded.length,
        total: refreshed.files.length,
        allUploaded: refreshed.allUploaded,
      });
    } finally {
      activeUploads.delete(key);
      release();
    }
  });

  // ---------------- 停止上传 ----------------

  router.delete('/api/shares/:id/files/:idx/upload', async (req, res, { params, url }) => {
    const { share, file, idx } = loadUploadTarget({ params, req, url });

    if (file.state === 'uploaded') {
      sendJson(res, 200, { ok: true, idx, removed: false, complete: true });
      return;
    }

    const key = uploadKey(share.id, idx);
    const entry = activeUploads.get(key);
    if (entry) {
      // 先让在途请求结束，再删分片，避免它继续追加
      entry.req.destroy();
      const settled = await Promise.race([
        entry.done.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      if (!settled) throw conflict('正在停止上传，请稍后重试');
    }

    const removed = await deleteStagedPart(locations, share.id, idx);
    updateFile(db, share.id, idx, { state: 'pending', receivedBytes: 0 });
    recordEvent(db, 'upload_cancel', { shareId: share.id });
    logger?.info('暂存上传已停止', { id: share.id, idx, removed });

    sendJson(res, 200, { ok: true, idx, removed, complete: false });
  });

  // ---------------- 下载 ----------------

  const downloadHandler = async (req, res, { params, url }) => {
    const share = getShareRow(db, params.id);
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    assertShareAvailable(share);

    if (share.kind !== 'file') throw badRequest('该分享不是文件分享');
    if (share.mode !== 'staged') {
      throw conflict('该分享的文件不经过服务器，请回到分享页面下载');
    }

    const idx = assertIndex(params.idx);
    const file = getFile(db, share.id, idx);
    if (!file) throw notFound('文件不存在');
    if (file.state !== 'uploaded') throw gone('该文件尚未上传完成或已被取走');

    const stat = await statStagedFile(locations, share.id, idx);
    if (!stat) throw gone('文件已不存在');

    // 交付语义敏感的分享（焚毁 / 限次）同一时刻只允许一个下载在途
    const guarded = share.burnAfterRead || share.maxDownloads !== null;
    const deliveryKey = `${share.id}:${idx}`;
    if (guarded && activeDeliveries.has(deliveryKey)) {
      throw conflict('该文件正在被取走，请稍后再试');
    }
    if (guarded) activeDeliveries.add(deliveryKey);

    try {
      const etag = fileEtag(stat);
      let range = parseRange(req.headers.range, stat.size);
      // 文件版本变了就不能续传旧分片，退化为完整文件
      if (range && !ifRangeMatches(req.headers['if-range'], etag)) range = null;

      if (range && range.unsatisfiable) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
          ETag: etag,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      const headers = {
        'Content-Type': file.mime || 'application/octet-stream',
        'Content-Disposition': contentDisposition(file.name),
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      };

      if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
        headers['Content-Length'] = range.end - range.start + 1;
        res.writeHead(206, headers);
      } else {
        headers['Content-Length'] = stat.size;
        res.writeHead(200, headers);
      }

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      try {
        await pipeline(createStagedReadStream(locations, share.id, idx, range ?? {}), res);
      } catch (err) {
        logger?.warn('下载中断', { id: share.id, idx, message: err?.message ?? String(err) });
        return;
      }

      // 只有完整发送完成才计次、才焚毁
      if (!res.writableFinished) return;

      incrementDownloads(db, share.id);
      recordEvent(db, 'download', { shareId: share.id });

      if (share.burnAfterRead) {
        await burnFile({ db, locations, logger, share, idx });
      }
    } finally {
      if (guarded) activeDeliveries.delete(deliveryKey);
    }
  };

  router.get('/api/shares/:id/files/:idx', downloadHandler);
  router.head('/api/shares/:id/files/:idx', downloadHandler);
}

/** 阅后即焚：删掉这个文件；如果它是最后一个，整个分享一起删 */
export async function burnFile({ db, locations, logger, share, idx }) {
  deleteFileRow(db, share.id, idx);
  await fsp.rm(locations.storedFile(share.id, idx), { force: true }).catch(() => {});

  const remaining = listFiles(db, share.id);
  if (remaining.length === 0) {
    await purgeShare({ db, locations, id: share.id, reason: 'burn' });
    logger?.info('阅后即焚：分享已销毁', { id: share.id });
    return;
  }

  const totalBytes = remaining.reduce((sum, item) => sum + item.size, 0);
  updateShare(db, share.id, { totalBytes, downloads: share.downloads + 1 });
  logger?.info('阅后即焚：文件已销毁', { id: share.id, idx, remaining: remaining.length });
}
