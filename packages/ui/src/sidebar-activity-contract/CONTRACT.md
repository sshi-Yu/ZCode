# Sidebar bottom activity

Owner: desktop-ui。此 ui 层模块仅覆盖本契约目录与 `sidebar-activity/SidebarBottomActivity.tsx`。依赖只声明 ui，复用现有 GlobalNoticeSurface 和通知 store；不接管同目录其他营销组件，也不依赖 services、runtime-config 或 account-model-projects。

组件只显示调用方提供的通知投影，缺省沿用 GlobalNoticeSurface 的原 store 来源。不持有 OAuth、额度、营销配置或任何 accepted queue；不构造服务、请求、轮询或新持久化。通知的生命周期与存储继续由现有 GlobalNoticeStore 所有者管理。

公开入口是 contract.ts 与原组件路径，兼容现有侧栏调用方。营销和高速卡获益分享退役仍须由对应 UI 所有者清理发布者与旧通知呈现；登记 managed 边界不代表那些产品行为已经验收。

此四件套不改变组件业务。按 PCS06/07/08 做代表性浏览器或 E2E 验收，并检查相关 React hooks；不新增 App 业务单测。
