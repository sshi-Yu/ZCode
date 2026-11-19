import type { ComponentProps } from "react";
import type { SidebarBottomActivity } from "../sidebar-activity/SidebarBottomActivity.js";

/**
 * 侧栏通知的展示端口；复用已有 GlobalNoticeStore，不持有账号、营销或服务事实。
 * 可注入现有 store；缺省沿用 GlobalNoticeSurface 的原默认来源。
 */
export type SidebarBottomActivityProps = NonNullable<ComponentProps<typeof SidebarBottomActivity>>;

export { SidebarBottomActivity } from "../sidebar-activity/SidebarBottomActivity.js";
