# ui-tool-model-details

公开入口 index.ts 的 ToolModelDetails 为自包含详情组件，不拥有导航；父级仅以本机 base services 的 toolModelSettingsService 存在作为能力门禁。组件通过 useToolModelSettings hook 访问服务，草稿与错误仅在本详情内；持久绑定、候选和修订归本机服务。读取/保存/切页均不发模型请求。暂不展示来源尚未证明的自动标题行。规格 docs/ui/tool-model-settings.md。
