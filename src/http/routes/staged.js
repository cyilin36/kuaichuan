/**
 * 暂存模式的文件上传与下载。
 *
 * PUT 上传：边写边校验大小，先 .part 再原子改名；配额不足会先清理最旧的暂存分享。
 * GET 下载：支持 Range 断点续传；成功后计次；阅后即焚的分享取走即删。
 */

import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { badRequest, conflict, forbidden, gone, notFound, payloadTooLarge } from '../../errors.js';
import { assertIndex } from '../../paths.js';
import { sendJson } from '../respond.js';
import { assertOctetStream, contentLength } from '../limits.js';
import { contentDisposition, parseRange } from '../download.js';
import { getFile, listFiles, deleteFile as deleteFileRow, updateFile } from '../../storage/files.repo.js';
import { incrementDownloads, recordEvent, updateShare } from '../../storage/shares.repo.js';
import { createStagedReadStream, statStagedFile, writeStagedFile } from '../../storage/staging.js';
import { assertShareAvailable, getShareRow, requireViewer } from '../../domain/shares.js';
import { extractToken } from '../../domain/tokens.js';
import { enforceQuota, purgeShare } from '../../domain/lifecycle.js';

/** 正在进行中的受限交付（阅后即焚 / 限次下载），避免同一个文件被并发取走两次 */
const activeDeliveries = new Set();

export function registerStagedRoutes(router, { config, logger, services }) {
  const { db, locations, tokenSecret } = services;

  router.put('/api/shares/:id/files/:idx', async (req, res, { params, url }) => {
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

    assertOctetStream(req);

    const declared = contentLength(req);
    if (declared !== null && config.maxFileBytes > 0 && declared > config.maxFileBytes) {
      throw payloadTooLarge(`单个文件不能超过 ${config.maxFileBytes} 字节`);
    }

    await enforceQuota({
      db,
      locations,
      logger,
      incomingBytes: declared ?? file.size,
      maxTotalBytes: config.maxTotalBytes,
      protectIds: [share.id],
    });

    updateFile(db, share.id, idx, { state: 'uploading' });

    let result;
    try {
      result = await writeStagedFile({
        locations,
        shareId: share.id,
        idx,
        stream: req,
        maxBytes: config.maxFileBytes,
      });
    } catch (err) {
      updateFile(db, share.id, idx, { state: 'pending' });
      throw err;
    }

    updateFile(db, share.id, idx, { state: 'uploaded', size: result.size, storedPath: `${idx}.bin` });

    const files = listFiles(db, share.id);
    const uploaded = files.filter((item) => item.state === 'uploaded');
    const totalBytes = uploaded.reduce((sum, item) => sum + item.size, 0);
    const allUploaded = uploaded.length === files.length;

    updateShare(db, share.id, {
      totalBytes,
      ...(allUploaded ? { status: 'active' } : {}),
    });
    recordEvent(db, 'upload', { shareId: share.id });

    logger?.info('暂存文件已上传', { id: share.id, idx, size: result.size, allUploaded });

    sendJson(res, 200, {
      ok: true,
      idx,
      size: result.size,
      uploaded: uploaded.length,
      total: files.length,
      allUploaded,
    });
  });

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
      const range = parseRange(req.headers.range, stat.size);
      if (range && range.unsatisfiable) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      const headers = {
        'Content-Type': file.mime || 'application/octet-stream',
        'Content-Disposition': contentDisposition(file.name),
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
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
