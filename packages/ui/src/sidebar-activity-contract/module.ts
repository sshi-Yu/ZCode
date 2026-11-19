/** 侧栏底部通知槽位；policy roots 精确覆盖契约目录与原展示组件。 */
export const sidebarBottomActivityModule = {
  id: "sidebar-bottom-activity",
  requires: ["ui"],
  provides: ["sidebar-bottom-notice-surface"],
  publicEntrypoints: ["contract.ts", "../sidebar-activity/SidebarBottomActivity.tsx"],
} as const;
