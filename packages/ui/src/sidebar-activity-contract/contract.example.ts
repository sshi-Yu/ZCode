import { createElement } from "react";
import { SidebarBottomActivity, type SidebarBottomActivityProps } from "./contract.js";

/** 调用方注入既有通知投影；组件不构造服务或触发营销刷新。 */
export function exampleSidebarBottomActivity(props: SidebarBottomActivityProps = {}) {
  return createElement<SidebarBottomActivityProps>(SidebarBottomActivity, props);
}
