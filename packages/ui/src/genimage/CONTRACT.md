# GenImage 视图

Shell 通过 `GenImageView` 挂载桌面主区，可附带现有窗口控件；菜单、平台门禁和会话导航不属于画布。`GenImageView` 持有该次挂载的相机、草稿与模拟节点，以节点的唯一 `source` 引用绘制谱系；布局或相机变更不写来源。卸载重置，不跨项目或窗口写入，不访问服务或插件。范围见 [视图规格](../../../../docs/superpowers/specs/2026-11-26-genimage-native-view-design.md)。
