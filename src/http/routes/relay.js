/**
 * 内存中继通道：P2P 模式下「打洞失败也照样能传，且全程不落盘」的兜底。
 *
 * 文字：POST /api/relay/:id/text（发送方） -> GET /api/relay/:id/text（接收方）
 * 文件：POST /api/relay/:id/f/:idx（发送方） -> GET /api/relay/:id/f/:idx（接收方）
 *
 * 两条通道都只经内存与 socket 缓冲区，绝不写磁盘。
 */

import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { assertIndex } from '../../paths.js';
import { sendJson } from '../respond.js';
import { contentDisposition } from '../download.js';
import { getFile, listFiles, deleteFile as deleteFileRow } from '../../storage/files.repo.js';
import { getShare, incrementDownloads, recordEvent, updateShare } from '../../storage/shares.repo.js';
import { assertShareAvailable, getShareRow, requireViewer } from '../../domain/shares.js';
import { extractToken } from '../../domain/tokens.js';
import { purgeShare } from '../../domain/lifecycle.js';
import { relayKey } from '../../realtime/relay-bridge.js';

export function registerRelayRoutes(router, { config, logger, services }) {
  const { db, locations, tokenSecret, bridge } = services;

  /** 分享必须存在、可用、且确实是 P2P 分享 */
  function loadP2PShare(id, kind) {
    const share = getShareRow(db, id);
    assertShareAvailable(share);
    if (share.kind !== kind) {
      throw badRequest(kind === 'text' ? '该分享不是文字分享' : '该分享不是文件分享');
    }
    if (share.mode !== 'p2p') {
      throw conflict('该分享可以直接下载');
    }
    return share;
  }

  /** 一次成功的中继取件：计次，必要时焚毁 */
  async function completeDelivery({ shareId, idx, kind }) {
    const share = getShare(db, shareId);
    if (!share) return;

    incrementDownloads(db, shareId);
    recordEvent(db, 'download', { shareId });

    if (!share.burnAfterRead) return;

    if (kind === 'text') {
      await purgeShare({ db, locations, id: shareId, reason: 'burn' });
      logger?.info('阅后即焚：中继文字分享已销毁', { id: shareId });
      return;
    }

    const file = getFile(db, shareId, idx);
    if (!file) return;
    deleteFileRow(db, shareId, idx);

    const remaining = listFiles(db, shareId);
    if (remaining.length === 0) {
      await purgeShare({ db, locations, id: shareId, reason: 'burn' });
      logger?.info('阅后即焚：中继文件分享已销毁', { id: shareId });
      return;
    }

    const fresh = getShare(db, shareId);
    updateShare(db, shareId, {
      totalBytes: remaining.reduce((sum, item) => sum + item.size, 0),
      downloads: fresh?.downloads ?? share.downloads,
    });
    logger?.info('阅后即焚：中继文件条目已销毁', { id: shareId, idx, remaining: remaining.length });
  }

  // ---------------- 文字 ----------------

  router.post('/api/relay/:id/text', async (req, res, { params, url }) => {
    const share = loadP2PShare(params.id, 'text');
    const viewer = requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    if (viewer.role !== 'owner') throw forbidden('只有分享的创建者可以发送内容');

    const key = relayKey(share.id, 'text');
    req.on('close', () => bridge.abort(key));

    const side = { req, res, meta: {} };
    const peer = await bridge.pair(key, 'upload', side);
    if (!peer) return; // 由对端架管道

    const result = await bridge.connect({
      key,
      upload: side,
      download: peer.ctx,
      maxBytes: config.maxTextBytes,
      contentType: peer.ctx.meta?.contentType ?? 'text/plain; charset=utf-8',
      headers: peer.ctx.meta?.headers ?? {},
    });
    if (result.ok) await completeDelivery({ shareId: share.id, kind: 'text' });
  });

  router.get('/api/relay/:id/text', async (req, res, { params, url }) => {
    const share = loadP2PShare(params.id, 'text');
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });

    const key = relayKey(share.id, 'text');
    req.on('close', () => bridge.abort(key));

    const side = { req, res, meta: { contentType: 'text/plain; charset=utf-8' } };
    const peer = await bridge.pair(key, 'download', side);
    if (!peer) return;

    const result = await bridge.connect({
      key,
      upload: peer.ctx,
      download: side,
      maxBytes: config.maxTextBytes,
      contentType: side.meta.contentType,
      headers: {},
    });
    if (result.ok) await completeDelivery({ shareId: share.id, kind: 'text' });
  });

  // ---------------- 文件 ----------------

  router.post('/api/relay/:id/f/:idx', async (req, res, { params, url }) => {
    const share = loadP2PShare(params.id, 'file');
    const viewer = requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    if (viewer.role !== 'owner') throw forbidden('只有分享的创建者可以发送文件');

    const idx = assertIndex(params.idx);
    if (!getFile(db, share.id, idx)) throw notFound('文件不存在');

    const key = relayKey(share.id, 'f', idx);
    req.on('close', () => bridge.abort(key));

    const side = { req, res, meta: {} };
    const peer = await bridge.pair(key, 'upload', side);
    if (!peer) return;

    const result = await bridge.connect({
      key,
      upload: side,
      download: peer.ctx,
      maxBytes: config.maxFileBytes,
      contentType: peer.ctx.meta?.contentType ?? 'application/octet-stream',
      headers: peer.ctx.meta?.headers ?? {},
    });
    if (result.ok) await completeDelivery({ shareId: share.id, idx, kind: 'file' });
  });

  router.get('/api/relay/:id/f/:idx', async (req, res, { params, url }) => {
    const share = loadP2PShare(params.id, 'file');
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });

    const idx = assertIndex(params.idx);
    const file = getFile(db, share.id, idx);
    if (!file) throw notFound('文件不存在');

    const key = relayKey(share.id, 'f', idx);
    req.on('close', () => bridge.abort(key));

    const side = {
      req,
      res,
      meta: {
        contentType: file.mime || 'application/octet-stream',
        headers: { 'Content-Disposition': contentDisposition(file.name) },
      },
    };
    const peer = await bridge.pair(key, 'download', side);
    if (!peer) return;

    const result = await bridge.connect({
      key,
      upload: peer.ctx,
      download: side,
      maxBytes: config.maxFileBytes,
      contentType: side.meta.contentType,
      headers: side.meta.headers,
    });
    if (result.ok) await completeDelivery({ shareId: share.id, idx, kind: 'file' });
  });

  router.get('/api/relay/stats', (req, res) => {
    sendJson(res, 200, {
      enabled: config.relayEnabled,
      active: bridge.activeCount(),
      pending: bridge.pendingCount(),
    });
  });
}
