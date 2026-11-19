# 保留账号模型的商业服务拆除实施计划

> **For agentic workers:** 用户已批准设计与实施范围，当前在 `refactor/personal-workbench-commercial-services` 按 A → B → C → D 推进。使用 superpowers:subagent-driven-development 或 superpowers:executing-plans。使用 `- [ ]` 跟踪尚未完成或尚未验收的任务；授权不代表代码已经实施或验证通过。禁止提交和推送。

**Goal:** 保留官方账号及已有套餐模型，移除应用中的交易、营销、主动云权益获取和新增闲时任务。

**Architecture:** 保持 OAuth → 账号模型来源 → Provider Registry → CLI 的原认证链。先分离订阅服务内的公共运行配置和已有项目读取，再退役商业消费者；闲时与常规 Cron 分别处理，保留正在执行任务的所有者和历史数据。

**Tech Stack:** TypeScript、React、Zustand、服务依赖注入与 RPC、Electron Host/CLI、SQLite、WDIO E2E。

---

设计依据：[已确认范围与候选验收](../specs/2026-11-19-personal-workbench-commercial-services-design.md)。日期：2026-11-19。

本文件是已批准的分阶段实施与验收清单；新接口目标见设计 §5.6。每阶段形成可独立评审的改动，不能一次性删完整 subscription/usage/automation 目录。既有两个方案文件是本会话新增文件，保留；真实账号配置和数据库不作为验收夹具，不启动用户生产应用。

## 0. 已确认范围

- 保留登录、账号信息与退出，已有个人/团队套餐模型、合法额度及必要凭据准备，自定义模型、历史、普通 Cron 与动态工作流。
- 移除购买/升级/续订/支付/订单入口及专用调用，奖励、邀请、促销、主动额度领取/重置、抽卡/获益分享，以及新增闲时任务和云票据调度。
- 保留已有合法 Start Plan/已激活高速卡所需的使用与到期逻辑；不伪造权益。
- 分享、手机远控、SSH/WSL、市场、更新与通用遥测本轮保持原范围。
- 不代替用户取消订阅或云端任务，不清理用户凭据或数据库；删除应用内续订入口不代表服务端停止自动续费。

## 1. 实施前门禁

- [x] 使用独立实现分支 `refactor/personal-workbench-commercial-services`；初始工作区仅两份本方案文档未跟踪，保留当前工作区无关改动。
- [ ] 确认实现环境使用 `mise.toml` 的 Node 24.14.0、pnpm 10.33.2；主线程报告 freshness 基线通过，初始 Node 为 24.12.0，不能将其写成已满足版本要求。
- [x] 读取 `.agents/skills/architecture-governance/SKILL.md`；主线程报告 `pnpm architecture:check --changed` 基线通过。本实施上下文已生成 services/ui/session，均为 unmanaged，新增源码须先按窄职责受管。
- [ ] 完成各执行单元所需指令阅读；本轮已读根及 services/ui/CLI 的 `AGENTS.md` 和 session-management，UI 实现者仍须读 `DESIGN.md`。
- [ ] 维护目标阶段相关 spec 与 E2E 场景，再修改交互实现。CLI/工程改动先补其回归，不新增 App 业务单测。
- [ ] 准备合成账号/模型夹具与独立数据目录，按 PCS01–PCS12 记录范围；不得使用个人生产数据做清库/迁移测试。

## 2. 阶段 A：建立保留能力边界

**目标：** 让非交易能力有独立接口，暂不改变原有请求语义。

**主要文件与职责：**

- `packages/services/src/coding-plan-subscription/codingPlanSubscription.ts`：当前混合契约，按运行配置/账号项目读取/商业动作分类。
- `packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts`：当前装配/委托，拆分实现入口。
- `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts`、`zaiCodingPlanSubscriptionProvider.ts`：保留两个账号域的项目发现和必要 API Key 准备。
- `packages/services/src/accessor.ts`、`node.ts`、`index.ts`：服务类型、实例装配与公共出口。
- `packages/client/src/remoteServiceAccess.ts`、`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`、`remoteWorkspaceRpcContract.ts`、`sourceSettingsServiceCollection.ts`：跨进程可访问接口与远程契约。
- `packages/ui/src/hooks/useDynamicWorkflowAvailability.ts`、`store/dynamicWorkflowAvailabilityStore.ts`、`root/oauthTeamPricing.ts`：迁移非交易消费者。

**步骤：**

- [ ] 逐项列出原接口直接消费者并分类；记录账号项目读取即使命名 pricing 仍须保留的原因。
- [ ] 通过架构 context 确定新接口归属，保持运行配置的缓存、失败和用户覆盖规则；不创建独立 UI 决策副本。
- [ ] 先迁移 Host/UI/remote 服务装配及消费者，再逐项缩减原接口；迁移期间避免重复请求和重复实例。
- [ ] 登录或刷新失败不能以空项目列表覆盖原选择；账号切换只更新对应账号域。
- [ ] 执行 PCS02/03/04/10/11 的代表性验收，证明已有套餐模型、团队项目、动态工作流与远程接口仍可用。

**退出条件：** 商业动作可以从服务契约独立撤下；非交易功能不再依赖交易入口，账号资格、请求认证和客户端配置来源没有改变。

## 3. 阶段 B：移除交易和营销链路

**目标：** 界面与服务同时退役，账号、模型及只读额度保留。

**主要文件与职责：**

- `packages/ui/src/Root.tsx`：解除营销、奖励及购买专用 Provider 的挂载与生命周期。
- `packages/ui/src/settings/CodingPlanUpgradeDialog.tsx`、`CodingPlanUpgradeDialogProvider.tsx`、`CodingPlanEmbeddedWebviewDialog.tsx`、`codingPlanUpgradeLoginRecovery.ts`：购买入口、内嵌页面及登录后续接。
- `packages/ui/src/settings/model-provider-section/Detail.tsx`、`StatusCards.tsx`、`ProviderFamilyModeHeader.tsx`、`useCodingPlanProducts.ts`、`useEnterpriseCodingPlanProducts.ts`、`codingPlanEmbeddedWebview.ts`：去除交易消费者，保留既有连接和项目选择。
- `packages/ui/src/components/marketing-touch/`、`rewards/`、`sidebar-activity/`、`components/coding-plan-quota-reset/`：营销/领取生命周期和界面入口。
- `packages/ui/src/highspeed/`、`packages/services/src/highspeed/`：仅退役新权益获取/促销分享；保留已有卡的模型认证、到期与历史读取。
- `packages/services/src/marketing-touch/` 及阶段 A 剩余商业方法：移除专用请求与装配。

**步骤：**

- [ ] 先维护 PCS01/04/06/07/08/12 与有关规格；定义旧入口、旧深链、旧打开状态的明确结果。
- [ ] 解除 UI 挂载、点击动作、购买恢复和轮询，删除促销专用事件；保留登录流程和通用 WebView。
- [ ] 删除服务中的交易/营销/主动领取方法和对应 RPC 暴露，未知旧调用明确失败，不以空成功响应掩盖。
- [ ] 清理专用文案、资产和技能引用前核对消费者；重用类型/桥接工具不能跟随单一页面一并删除。
- [ ] 网络证据检查登录、设置页、任务完成、后台刷新周期；覆盖所有进程，按目的区分允许的账号项目读取和禁止的商业动作。
- [ ] 先有退役后的 E2E 断言，再清理只验证旧营销购买行为的测试与 fixtures；不删除账号权益展示、错误态和隔离用例。

**退出条件：** 用户仍可登录和使用已有模型；没有购买、领取、营销页面和专用请求；已有真实权益到期/耗尽逻辑不变。

## 4. 阶段 C：退役闲时任务，保留常规调度

**目标：** 新闲时任务和票据流程停止，已有历史可读，常规 Cron 与当前会话继续工作。

**主要文件与职责：**

- `packages/ui/src/v4/OffPeakNewTaskEntry.tsx`、`settings/OffPeakTaskList.tsx`、`OffPeakEditView.tsx`、`OffPeakHistoryTab.tsx`、`store/offPeakTaskStore.ts`、`hooks/useOffPeakEligibility.ts`：创建入口、状态与历史。
- `packages/services/src/session/offPeakTaskService.ts`、`offPeakTaskRepo.ts`、`offPeakServerClient.ts`、`offPeakRuntimeModel.ts`、`offPeakResidentExecutions.ts`：本地记录、票据、派发和已有执行收尾。
- `packages/services/src/model-provider/offPeakModelSelectionView.ts`：专用闲时模型视图；普通 Provider/默认模型不得被误改。
- `packages/desktop/src/main/desktopCronScheduler.ts`：共享调度消息和执行转发，保留普通 Cron。
- `packages/ui/src/ToolCallBlocks/renderers/offpeak-create.tsx`：旧工具结果兼容展示。
- CLI OffPeak 工具注册及宿主 capability：实施前按 `OffPeakCreate`/`OffPeakList` 直接调用方精确定位；删除新操作能力时保留旧 transcript 的解析。

**步骤：**

- [ ] 冻结 PCS09/10/12 与退役状态的存储合同，覆盖 queued/running/终态和完整重启；禁止清库迁移。
- [ ] 拒绝新创建和重新提交，停止取号和新派发；模型工具列表与服务能力一致，防止隐藏 UI 后 Agent 仍创建任务。
- [ ] 待执行记录保留并标注本地退役；已有 running 沿原 owner 收尾，不转普通付费模型任务。
- [ ] 过渡收尾完成后停止专用轮询与云同步；共享调度器的 Cron 路径继续执行。没有运行任务的冷启动立即停止闲时专用请求。
- [ ] 保留任务 ID、历史、旧工具结果和用户取消现有运行的能力；迁移重复运行幂等，不向云端自动发取消。
- [ ] 验证普通 Cron、会话输入队列、动态工作流、Subagent 模型选择及重启恢复。

**退出条件：** 零新闲时任务/派发；无活跃闲时执行时专用请求归零；原有历史和常规调度完整。

## 5. 阶段 D：清理与验收收口

- [ ] 使用 dep-refs 技能核查待删 TypeScript 导出引用，清理服务注册、协议字段、资产、i18n、文档和技能中的失效入口。
- [ ] 按正式 E2E 流程维护 spec、case catalog、coverage matrix 与 manifest，不把准备状态计为通过或转正。
- [ ] 在保留账号和个人模型的场景核对历史数据、默认选择和跨工作区隔离；只迁移退役功能状态。
- [ ] 核对 UI 表述：移除应用交易入口不等于服务端退订；没有账号模型可用时提供真实原因与自定义模型入口。
- [ ] 运行类型、Lint、架构与相关回归；检查新增或相关 React Hooks 警告，不能只读退出码。
- [ ] 汇总每项结果、未执行的平台/环境与迁移证据；交付后再按用户授权决定提交/发布。

## 6. 验证入口与证据规则

根目录确认存在的命令：

```bash
node scripts/check-workspace-freshness.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

E2E 使用 `packages/desktop/package.json` 的当前入口。针对已存在的套餐展示回归，可从根目录运行：

```bash
ZCODE_E2E_SPEC=./test/e2e/settings/providers/coding-plan-entitlement-presentation.test.ts pnpm --filter @zcode/desktop test:e2e:serial
```

该用例仅是保留能力参考，不代表 PCS 全部覆盖。新退役用例依 `e2e-case-lifecycle` 的人工审查、合成 provider 夹具、隔离数据目录及转正流程接入；未创建具体文件前不预报通过或声称已注册进套件。不得直接全量运行可能访问真实账号或外部服务的测试。

App 业务单测已退役；CLI/工程验证按目标包现存 `package.json` 与测试文件执行。对无变更的逻辑不重复全量测试；任一失败记录原输出与影响范围。

## 7. 实施分工与文件所有权

以下任务书中的路径相对于仓库根 `C:/max_project/my/tools/ZCode`，由主线程派发；同一文件不得交给两个同时运行的实现者。A 契约落地后才迁移 B 的消费者；C 可以先在专属文件维护规格和回归，OffPeak 代码按 A → B → C 的验收顺序收口。所有单元报告限定 20 行以内，包含状态、实际修改文件、验证命令/退出码、未验证范围和需主线程协调的接口冲突，不贴大段源码。

### A：后端非交易服务分离与商业后台退役

- **目标与完成标准：** 完成设计 §5.6 的两个非交易面；保留请求来源/缓存/family/错误语义，再删除交易、营销、重置机会、领取和新 draw 专用调用。B/C 消费契约后，直接 RPC 也不能重新发起这些动作。Start Plan 资格、已激活卡、Usage 和 Team API Key 准备保持真实。
- **专属范围：** `packages/services/src/coding-plan-subscription/`、`marketing-touch/`、`highspeed/`、`usage-stats/`；最小新 managed 服务目录；`packages/services/src/accessor.ts`、`node.ts`、`index.ts`；`packages/client/src/remoteServiceAccess.ts`；`packages/desktop/src/host/{sourceSettingsServiceCollection,remoteWorkspaceServiceCollection,remoteWorkspaceRpcContract,windowHostAttachmentRpcPolicy}.ts`；`packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts`；`packages/web/src/main.tsx`；`packages/shared/src/channels.ts` 与本次 commercial/highspeed/usage 契约。所有 `architecture-policy.yaml` 注册统一由 A 汇集其他单元所需增量后修改。
- **必需跨层接线：** 服务 descriptor → ServiceChannels → IServiceAccessor → Host 本地/Source/remote 注册 → Client Proxy → renderer/普通 Web 的服务对象；按实际类型引用补齐，不仅改 node.ts。B 所有 UI 消费者使用相同命名；C 的 OffPeak 注入请求由 A 合并到 node.ts。
- **参考：** 本设计 §5.1/5.2/5.4/5.6；`packages/services/AGENTS.md`；`packages/services/src/client-config/clientConfig.ts`（其公开快照不能无证据替代运行配置）；`packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts`；`packages/services/src/highspeed/highspeedCardService.ts`。
- **验证：** `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；合成 API transport/RPC 验收 PCS02/03/04/08/11/12，核对 BigModel/Z.AI、失败/空列表、卡到期、动态工作流失败关闭和未知旧商业调用零网络。不得新增 App 业务单测。

### B：前端交互与旧入口退役

- **目标与完成标准：** 官方账号、已有个人/团队模型、只读用量、Provider 配置保留；购买、营销、领取、抽卡和 OffPeak 新建/继续 UI 及 lifecycle 请求退出，旧链接不打开购买/奖励页、不注入专用凭据；旧 OffPeak 历史与 running 仍能解释。
- **专属范围：** `packages/ui/src/` 下本计划所列及其直接消费者，尤其 `Root.tsx`、`v4/SessionPane.tsx`、`hooks/useDynamicWorkflowAvailability.ts`、`store/dynamicWorkflowAvailabilityStore.ts`、`root/oauthTeamPricing.ts`、`hooks/useCodingPlanEntryPlanList.ts`、`settings/model-provider-section/`、`components/marketing-touch/`、`marketing-touch-contract/`、`rewards/`、`sidebar-activity/`、`components/coding-plan-quota-reset/`、`chat-input-toolbar/`、`highspeed/`、OffPeak 页面/store/hooks/旧工具展示、相关 i18n 与专用资产。购买/奖励专用 preload 桥文件 `packages/desktop/src/preload/{codingPlanWebview,rewardsWebview}.ts` 也归 B；任何通用 Main/平台接线文件先上报主线程协调。
- **必需跨层协作：** 消费 A 冻结的 `runtimeConfigService` / `accountModelProjectsService`；C 提供退役失败和本地历史语义，B 不新增 accepted queue、不持有业务迁移真值。C 不修改 UI 目录，A 不修改 UI 文件。
- **参考：** `packages/ui/AGENTS.md`、`DESIGN.md`、本设计 UI Surface Matrix 与 PCS01/03/04/06/07/08/09。`useEnterpriseCodingPlanProducts` 同时服务已有团队选择，不能全删；`highspeed/` 中请求使用、owner 和到期展示不能整目录删除。
- **验证：** 先由 E2E 所有者维护 PCS 相应断言，再改交互；`pnpm typecheck`、`pnpm lint` 并逐项复核相关 hooks 诊断，忽略文件补专扫；代表性桌面/手机、中英、深浅主题运行验收，未运行的明确报告。不得用隐藏入口代替后台请求验收。

### C：OffPeak admission、调度与历史兼容

- **目标与完成标准：** 无新创建/取号/继续/派发；无已确认运行实例时无专用同步/终态历史重报；原 running owner 收尾与取消能力保留；历史 ID、字段和数据保留，未知重启状态不重放、不转付费任务。Cron 与动态工作流继续可用。
- **专属范围：** `packages/services/src/session/offPeak*.ts`、`packages/services/src/model-provider/offPeakModelSelectionView.ts`、`packages/services/src/zcode-agent/zcodeAgentService.ts`；`packages/desktop/src/scheduler/` 的 OffPeak 分支及协议、`packages/desktop/src/host/index.ts`、`host/offPeakDispatchPlan.ts`、`main/desktopCronScheduler.ts`、必要的 `main/desktopHostProcess.ts`；`packages/shared/src/off-peak-types.ts`、`off-peak-execution.ts` 与 OffPeak 执行协议；`apps/zcode-cli/packages/{core,bootstrap,contracts,adapters}` 中 OffPeak 工具/capability 与对应既有测试，CLI tool-chain spec。`node.ts`、`channels.ts`、架构策略不归 C，所需修改用精确片段/契约交 A；不修改 B 的 UI 文件。
- **必需端点：** `OffPeakTaskService.createTask/getTakeNumberAvailability/continueTask` 先于 IO 明确拒绝；`runSyncCycle/startSync` 不再扫描 queued 或全部旧终态；scheduler tick 与 Host `dispatchOffPeakRun` 双向挡住旧来源的新派发；CLI 注册/handler/host request 不能绕过门禁。保留 transcript schema、running lifecycle、owner/lease/stale run、原请求鉴权。
- **参考：** `.agents/skills/session-management/SKILL.md`、`docs/agents/runtime-boundaries.md`、`apps/zcode-cli/AGENTS.md` 与 `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`、本设计 §5.5/5.6。注意 `workflow.ts` 共用 OffPeak handler 的 turn guard，删除 handler 前查引用，不能破坏工作流保护。
- **验证：** `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；`pnpm --dir apps/zcode-cli typecheck`、`pnpm --dir apps/zcode-cli lint`；按现存 package 脚本运行 core/bootstrap/contracts/adapters 的受影响 OffPeak 测试；隔离夹具覆盖 queued/paused/running/终态/重启/迟到结果、普通 Cron、动态工作流。测试必须断言无 takeTicket/batchStatus/新派发，并区分必要运行收尾与历史 outbox，不能仅断言 UI 不可见。

### 质量、E2E 与整合所有权

E2E 规格、测试、fixtures、case catalog、coverage matrix、manifest 统一由主线程指定一个所有者，先于对应交互落地。参考范围是 `packages/desktop/test/e2e/settings/providers/`、`ui-shell/marketing/`、`conversation-session/entitlements/`、`automations/off-peak/` 和 `conversation-session/automations/`，不是恢复 App 业务单测的许可。

实现结束后依次进行 reviewer 的规格/代码/UI 评审、Critical 清零、qa 命令和运行验收。每个执行单元的自评不替代独立 review；只有主线程能记录质量豁免。保留任何未执行平台或真实账号情形的限制，不将合成接口验收写成真实付费账号已通过。

## 8. 交付边界

方案批准与实施进行中不代表已验收。最终交付以实际源码差异、命令结果、独立 review 和 PCS 运行证据为准；先前模型路由 10 项定向通过的记录不能替代本轮验收。

本轮不删除账号或云端资源，不改变服务端订阅状态，不承诺断开所有官方服务；保留账号模型意味着保留其合法网络依赖。应用内移除续订入口不等于服务端自动续费已经停止。
