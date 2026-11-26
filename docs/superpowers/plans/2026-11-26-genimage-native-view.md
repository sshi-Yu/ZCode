# GenImage 内置画布视图 Implementation Plan

> **For agentic workers:** Use the desktop acceptance case as the contract, then verify the native renderer in Electron.

**Goal:** 在 ZCode 主区复刻已确认的插件预览，仅用本地 SVG 数据。

**Architecture:** Shell 管理生图导航，独立的 `ui-genimage-view` 管理画布局部状态，采用应用主题与组件。插件及 Host 不变。

**Tech Stack:** React、CSS 容器查询、SVG、WDIO。

- [x] 先在桌面候选中固定入口、初始谱系、派生及离开重置；用现有开发客户端确认缺少入口。
- [x] 注册 UI 模块契约，移植示例图、视图和交互，按容器本地坐标处理相机与浮层。
- [x] 接到 Shell 主视图及桌面侧栏，复用窗口控件和返回导航。
- [x] 在 Electron 验证派生与导航、拖拽和窄宽布局，执行架构、类型和 lint 检查。
