/**
 * 解锁接口：校验密码并签发访问令牌。
 * 无密码分享也走这里（前端统一流程，服务端统一鉴权）。
 */

import { sendJson } from '../respond.js';
import { readJsonBody } from '../limits.js';
import {
  assertShareAvailable,
  getShareRow,
  listShareFiles,
  publicMetadata,
  unlockShare,
} from '../../domain/shares.js';

export function registerUnlockRoutes(router, { config, services }) {
  const { db, tokenSecret } = services;

  router.post('/api/shares/:id/unlock', async (req, res, { params }) => {
    const body = await readJsonBody(req);
    const share = getShareRow(db, params.id);
    assertShareAvailable(share);

    const { accessToken, expiresIn } = await unlockShare({
      db,
      config,
      tokenSecret,
      share,
      password: typeof body.password === 'string' ? body.password : '',
    });

    const fresh = getShareRow(db, share.id);
    const presence = services.presence;
    sendJson(res, 200, {
      accessToken,
      expiresIn,
      share: publicMetadata({
        share: fresh,
        files: listShareFiles(db, share.id),
        role: 'access',
        senderOnline: share.mode === 'p2p' && presence?.isOnline
          ? presence.isOnline(share.id)
          : null,
      }),
    });
  });
}
