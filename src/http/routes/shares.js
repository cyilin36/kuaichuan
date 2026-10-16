/**
 * 分享相关接口：创建、读取元数据、撤销、二维码。
 */

import QRCode from 'qrcode';

import { forbidden } from '../../errors.js';
import { sendJson } from '../respond.js';
import { readJsonBody } from '../limits.js';
import { extractToken } from '../../domain/tokens.js';
import {
  assertShareAvailable,
  createShare,
  getShareRow,
  listShareFiles,
  normalizeOrigin,
  publicMetadata,
  requireViewer,
  revokeByOwner,
} from '../../domain/shares.js';

function senderOnlineOf(services, share) {
  if (share.mode !== 'p2p') return null;
  const presence = services.presence;
  if (!presence || typeof presence.isOnline !== 'function') return null;
  return presence.isOnline(share.id);
}

function pickOrigin({ requested, share, config, requestOrigin }) {
  return normalizeOrigin(requested)
    ?? normalizeOrigin(share.baseUrl)
    ?? normalizeOrigin(config.baseUrl)
    ?? normalizeOrigin(requestOrigin)
    ?? `http://localhost:${config.port}`;
}

export function registerShareRoutes(router, { config, logger, services }) {
  const { db, locations, tokenSecret } = services;

  router.post('/api/shares', async (req, res, { url }) => {
    const body = await readJsonBody(req);
    const created = await createShare({
      db, config, logger, input: body, requestOrigin: url.origin,
    });
    sendJson(res, 201, created);
  });

  router.get('/api/shares/:id', async (req, res, { params, url }) => {
    const share = getShareRow(db, params.id);
    const viewer = requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    assertShareAvailable(share);

    sendJson(res, 200, publicMetadata({
      share,
      files: listShareFiles(db, share.id),
      role: viewer.role,
      senderOnline: senderOnlineOf(services, share),
    }));
  });

  router.delete('/api/shares/:id', async (req, res, { params, url }) => {
    const share = getShareRow(db, params.id);
    const viewer = requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    if (viewer.role !== 'owner') throw forbidden('只有分享的创建者可以撤销');

    const result = await revokeByOwner({ db, locations, share });
    logger?.info('分享已撤销', { id: share.id, alreadyRevoked: result.alreadyRevoked });
    sendJson(res, 200, { ok: true, revoked: true, alreadyRevoked: result.alreadyRevoked });
  });

  router.get('/api/shares/:id/qr.svg', async (req, res, { params, url }) => {
    const share = getShareRow(db, params.id);
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    assertShareAvailable(share);

    const origin = pickOrigin({
      requested: url.searchParams.get('origin'),
      share,
      config,
      requestOrigin: url.origin,
    });
    const svg = await QRCode.toString(`${origin}/s/${share.id}`, {
      type: 'svg',
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'M',
    });

    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(svg);
  });
}
