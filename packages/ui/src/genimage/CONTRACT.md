# GenImage 视图

Shell 通过 `GenImageView` 挂载桌面主区，可附带现有窗口控件。Shell 提供本机 `localScope` 和显示名称。未提供范围时只显示 SVG 样例，空字符串是个人画布的有效范围。

每次打开视图先显示 SVG 样例。显式切换至本机模拟后，视图读取对应范围的保存画布，按返回节点的坐标和关系重新取景。切换范围和模式会重置相机、选中节点及草稿。

本机 Host 保存节点、坐标、版本和素材。视图用提交时确认的单一 `sourceId` 和 `requestId` 发起生成。结果到达后保留用户当前选择和相机，仅在首张图超出可见区域时重新取景。只有原提交面板仍打开时才关闭该面板。拖动结束或键盘微移时才提交坐标与预期版本。历史定位使用节点 ID，预览和导出从 Host 获取经检查的原图，导出通过平台保存对话框。

范围见 [视图规格](../../../../docs/superpowers/specs/2026-11-26-genimage-native-view-design.md) 和[本机画布实施计划](../../../../docs/superpowers/plans/2026-11-27-genimage-local-canvas.md)。
