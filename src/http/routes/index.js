/**
 * 路由注册总入口。各阶段的路由模块在这里挂上。
 */

import { registerHealthRoutes } from './health.js';

export function registerRoutes(router, deps) {
  registerHealthRoutes(router, deps);
}
