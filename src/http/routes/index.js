/**
 * 路由注册总入口。各阶段的路由模块在这里挂上。
 */

import { registerHealthRoutes } from './health.js';
import { registerShareRoutes } from './shares.js';
import { registerUnlockRoutes } from './unlock.js';
import { registerNetworkRoutes } from './network.js';
import { registerStagedRoutes } from './staged.js';
import { registerTextRoutes } from './text.js';
import { registerRelayRoutes } from './relay.js';
import { registerRtcRoutes } from './rtc.js';

export function registerRoutes(router, deps) {
  registerHealthRoutes(router, deps);
  registerShareRoutes(router, deps);
  registerUnlockRoutes(router, deps);
  registerNetworkRoutes(router, deps);
  registerStagedRoutes(router, deps);
  registerTextRoutes(router, deps);
  registerRelayRoutes(router, deps);
  registerRtcRoutes(router, deps);
}
