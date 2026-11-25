# 原生生图界面

桌面壳层经公开入口挂载工作台。设置页经同一入口挂载连接编辑器。两处都通过 `useBaseWorkspaceServices()` 读取本机 Host，工作区切换不改变图库或生图连接的所有者。

- 工作台持有当前视口、浮层与提示词草稿，设置详情持有编辑草稿和临时 Key 输入。已保存配置、任务和资产以 Host 回执或只读投影为准。
- 用户确认后只提交本次确定的请求。视图卸载取消未受理确认，已受理任务继续由 Host 持有。`accepted` 与 `replayed` 均展示返回的 Host 任务。已知请求前拒绝直接反馈；不明确的 RPC 结果保留原 ID，只通过 `getRequest` 核对，读取失败或暂未找到可重读，不能据此换 ID 或重发。
- 保存原图经 `IPlatformService.saveFile`。系统对话框取消、读取失败和保存结果分别反馈。
- 桌面壳层负责可见性、导航与窗控条件。工作台从 `onOpenSettings` 进入「生图连接」，设置退出后还原工作台。

## 生图设置详情

- `ImageGenerationSettings({ onDirtyChange? })` 管理连接选择、连接／模型草稿、写入式密钥与默认项草稿。父级根据 `onDirtyChange` 拦截设置导航；组件内切换连接、新增及刷新先确认放弃，放弃和卸载清空密钥。
- API Key 输入始终为空起步；输入表示 replace，keep 不读取密钥，remove 必须显式选择。官方预设目的地只读；自定义目的地改变后必须重新输入密钥，并确认包含完整目标的接收方说明。
- 自定义连接可选择 `openai-images` 或 `openai-images-b64`，官方预设锁定原协议。Base64 兼容协议只提供默认／1024／2048 方形尺寸并隐藏背景；切换协议时移除不支持的尺寸和背景、保留质量。协议属于目的地合同，切换后要求重新输入 Key 和确认；保存／重开不触发验证或生成。
- 默认项与连接草稿分别携带读取时的修订，涉及停用或删除当前默认时必须先选择可用替换项或显式清空。连接保存／删除与默认更新在同一服务命令中提交；单独默认变更走 `setDefaultSelection`。冲突保留草稿与临时密钥，不自动重放写入。
- 所有测试仅针对已保存、启用、已配置密钥的连接；有草稿时禁用。探测只调用 `probeConnection`，同一设置页／Window Host 合并重复探测，各 Host 共享最新结果序号但不跨 Host 合并。试生成确认冻结目的地、连接修订、模型、合并后的参数、样例版本与提示词，说明 PNG 单张限制及可能费用；取消和卸载不提交。
- 试生成仅显式确认后创建请求 ID，失败回执只用 `getRequest` 只读核对，轮询结果从不重发。最近探测／试生成显示 Host 的修订、模型、状态、耗时与本地化诊断；旧修订标为待重新验证。
- 保存、删除和测试反馈复用外层 `ProviderDetailFeedback`。稳定验收入口为 `genimage-settings`、`genimage-api-key`、`genimage-save-settings`、`genimage-add-connection`、`genimage-connection-select`、`genimage-probe` 和 `genimage-trial-${modelKey}`。

```text
设置草稿／临时 Key → 带 expectedRevision 的显式命令 → 本机 Host 配置 owner
测试确认（revision + sampleVersion）→ Host 受理 → 固定目标执行一次
设置页只读轮询 requestId ← Host 任务结果；离开只取消未受理确认
```

对应维护候选为 `packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/image-generation-workspace.test.ts` BI02、BI04、BI05；BI02 旧密钥输入选择器继续可用，完整连接管理与测试交互按评审设计 §§2–4 验收。

规格与验收见 [内置生图工作台与模型设置](../../../../docs/superpowers/specs/2026-11-25-builtin-image-generation-model-settings-design.md)。
