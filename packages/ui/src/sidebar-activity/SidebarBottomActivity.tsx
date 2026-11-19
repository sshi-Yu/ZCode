import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

/** 共享通知槽位保留普通通知；营销 Banner 已退役，不再挂载其查询或刷新生命周期。 */
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
