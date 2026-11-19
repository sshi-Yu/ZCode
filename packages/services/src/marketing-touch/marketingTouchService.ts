import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";

/** 旧营销 RPC 显式拒绝，不读取身份、不发请求、不授权营销资源。 */
export function createRetiredMarketingTouchService(): IMarketingTouchService {
  return {
    async query() {
      throw new Error("commercial_service_unsupported:query");
    },
    async report() {
      throw new Error("commercial_service_unsupported:report");
    },
  };
}
