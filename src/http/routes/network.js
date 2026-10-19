/**
 * 候选访问地址：让发送方自己挑一个内嵌进链接与二维码。
 *
 * 场景：在家里用 localhost 打开页面，但要把链接给手机用，
 * 这时必须用局域网地址，否则对方打不开。
 *
 * 注意：Docker 网桥、虚拟机网卡这类虚拟接口对别人是不可达的，
 * 全部塞进候选列表只会淹没有效地址，所以只在没有真实网卡时才退而求其次。
 */

import os from 'node:os';

import { sendJson } from '../respond.js';
import { normalizeOrigin } from '../../domain/shares.js';

/**
 * 容器与虚拟机网桥：它们只在本机内部有意义，列出来只会淹没有效地址。
 *
 * 有意**不**过滤 tailscale / wg / tun 这类隧道接口：
 * 那些地址对同一个 tailnet 或 VPN 里的同伴是真能访问的，属于有效候选。
 */
const VIRTUAL_IFACE = /^(br-|docker|veth|virbr|vmnet|vboxnet|bridge)/i;

/** 链路本地地址（169.254.x.x）对别人没有意义 */
function isLinkLocal(address) {
  return address.startsWith('169.254.');
}

/**
 * 从网卡列表里挑出人类可用的局域网地址。
 * 纯函数，方便单测（真实网卡列表在测试机上不可控）。
 *
 * @param {Record<string, Array<{address: string, family: string, internal: boolean}>>} interfaces
 * @returns {Array<{ url: string, label: string }>}
 */
export function selectLanCandidates(interfaces, { scheme = 'http', port }) {
  const preferred = [];
  const virtual = [];

  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (isLinkLocal(address.address)) continue;

      const candidate = { url: `${scheme}://${address.address}:${port}`, label: `局域网（${name}）` };
      if (VIRTUAL_IFACE.test(name)) virtual.push(candidate);
      else preferred.push(candidate);
    }
  }

  // 有真实网卡就只给真实的；一个都没有时（例如全容器环境）才把虚拟网卡也端出来
  return preferred.length > 0 ? preferred : virtual;
}

export function registerNetworkRoutes(router, { config }) {
  router.get('/api/network', (req, res) => {
    const host = req.headers.host ?? '';
    const scheme = req.socket?.encrypted ? 'https' : 'http';
    const portFromHost = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '';
    const port = portFromHost || String(config.port);

    const candidates = [];
    const push = (url, label) => {
      const normalized = normalizeOrigin(url);
      if (normalized && !candidates.some((item) => item.url === normalized)) {
        candidates.push({ url: normalized, label });
      }
    };

    if (config.baseUrl) push(config.baseUrl, '配置的 BASE_URL');
    if (host) push(`${scheme}://${host}`, '当前访问的地址');

    for (const candidate of selectLanCandidates(os.networkInterfaces(), { scheme, port })) {
      push(candidate.url, candidate.label);
    }

    push(`${scheme}://localhost:${port}`, '仅本机可用');

    sendJson(res, 200, { candidates, configured: config.baseUrl || null });
  });
}
