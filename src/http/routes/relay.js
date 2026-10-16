/**
 * 内存中继通道：P2P 模式下「打洞失败也照样能传，且全程不落盘」的兜底。
 *
 * 文字：POST /api/relay/:id/text（发送方） -> GET /api/relay/:id/text（接收方）
 * 文件：P5 阶段补充 /api/relay/:id/f/:idx
 */

import { badRequest, conflict, forbidden } from '../../errors.js';
import { sendJson } from '../respond.js';
import { incrementDownloads, recordEvent } from '../../storage/shares.repo.js';
import { assertShareAvailable, getShareRow, requireViewer } from '../../domain/shares.js';
import { extractToken } from '../../domain/tokens.js';
import { purgeShare } from '../../domain/lifecycle.js';
import { relayKey } from '../../realtime/relay-bridge.js';

export function registerRelayRoutes(router, { config, logger, services }) {
  const { db, locations, tokenSecret, bridge } = services;

  /** 分享必须存在、可用、且确实是 P2P 文字分享 */
  function loadTextShare(id) {
    const share = getShareRow(db, id);
    assertShareAvailable(share);
    if (share.kind !== 'text') throw badRequest('该分享不是文字分享');
    if (share.mode !== 'p2p') throw conflict('暂存分享请直接下载，不需要中继');
    return share;
  }

  router.post('/api/relay/:id/text', async (req, res, { params, url }) => {
    const share = loadTextShare(params.id);
    const viewer = requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    if (viewer.role !== 'owner') throw forbidden('只有分享的创建者可以发送内容');

    const key = relayKey(share.id, 'text');
    req.on('close', () => bridge.abort(key));

    const side = { req, res, meta: {} };
    const peer = await bridge.pair(key, 'upload', side);

    if (peer) {
      const result = await bridge.connect({
        key,
        upload: side,
        download: peer.ctx,
        maxBytes: config.maxTextBytes,
        contentType: peer.ctx.meta?.contentType ?? 'text/plain; charset=utf-8',
      });
      if (result.ok) await completeTextDelivery({ db, locations, logger, share });
      return;
    }

    // 由对端负责架管道，本端响应会在传输结束时由对端写回
  });

  router.get('/api/relay/:id/text', async (req, res, { params, url }) => {
    const share = loadTextShare(params.id);
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });

    const key = relayKey(share.id, 'text');
    req.on('close', () => bridge.abort(key));

    const side = { req, res, meta: { contentType: 'text/plain; charset=utf-8' } };
    const peer = await bridge.pair(key, 'download', side);

    if (peer) {
      const result = await bridge.connect({
        key,
        upload: peer.ctx,
        download: side,
        maxBytes: config.maxTextBytes,
        contentType: side.meta.contentType,
      });
      if (result.ok) await completeTextDelivery({ db, locations, logger, share });
      return;
    }

    // 由对端负责架管道
  });

  router.get('/api/relay/stats', (req, res) => {
    sendJson(res, 200, {
      enabled: config.relayEnabled,
      active: bridge.activeCount(),
      pending: bridge.pendingCount(),
    });
  });
}

/** 中继取件成功后：计次，必要时焚毁 */
async function completeTextDelivery({ db, locations, logger, share }) {
  const fresh = db.prepare('SELECT id FROM shares WHERE id = ?').get(share.id);
  if (!fresh) return;

  incrementDownloads(db, share.id);
  recordEvent(db, 'download', { shareId: share.id });

  if (share.burnAfterRead) {
    await purgeShare({ db, locations, id: share.id, reason: 'burn' });
    logger?.info('阅后即焚：中继文字分享已销毁', { id: share.id });
  }
}
