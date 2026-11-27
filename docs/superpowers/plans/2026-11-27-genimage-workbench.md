# 图像工作台实施计划

> 按下列任务推进。每个阶段先补对应验收，再实现该阶段的行为并保存运行证据。

**目标**　交付独立于 ZCode 项目的图像工作台，跑通「使用模板 → 补素材或一句话填槽 → 运行 → 比较和修改 → 定稿 → 重开继续」。

**架构**　现有本机图像 Host 持有作品、画布、素材、模板和运行状态。会话继续使用现有 Agent 运行时，由 Host 按作品绑定会话并约束工具。模板展开计划是确定性计算，真正的执行通过同一个图像操作入口受理。

**技术栈**　Electron window-scoped Local Host、React、现有图像 RPC、TypeScript / Zod、原子文件写入、WDIO 桌面验收和隔离供应商回放。

**产品依据**　[图像工作台设计](../specs/2026-11-27-genimage-workbench-design.md)和[现有图像画布](../specs/2026-11-27-genimage-canvas-product-design.md)。

## 开工与验收入口

- [ ] 运行 `node scripts/check-workspace-freshness.mjs`、`pnpm architecture:check --changed`，按实际涉及的模块读取 `pnpm architecture:context genimage` 和 `pnpm architecture:context ui-genimage-view`。会话阶段追加相应 Host、协议和运行时模块上下文。保留工作区现有改动。
- [ ] 重跑 `pnpm typecheck` 和 `pnpm lint`，记录开始时的失败或告警。近期类型检查在现有画布组件和图像 E2E 报错，以本轮基线输出为准。
- [ ] 维护下列桌面候选用例后再修改对应交互。沿用图像领域的 `manual-review/pending` 目录、隔离应用数据及本机测试图。会话使用固定 `E2E_*` 文本和 provider replay，供应商图像请求使用可控制返回及请求计数的本机注入。

候选文件均位于 `packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/`。在 PowerShell 中设置 `$env:ZCODE_E2E_MANUAL_REVIEW = '1'`，从仓库根目录使用 `pnpm --filter @zcode/desktop test:e2e:serial -- --spec './test/e2e/workspace/image-generation/manual-review/pending/genimage-workbench.test.ts'`，另两个文件按表替换文件名。

| 用例   | 候选文件                             | 准备、操作和必须通过的断言                                                                                                                                 |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IWB-01 | `genimage-workbench.test.ts`         | 从空白建两件作品，切换普通任务或项目后再打开图像。相同的作品出现在工作台，画布和简报各自恢复。验证重命名、归档、恢复。                                     |
| IWB-02 | `genimage-workbench.test.ts`         | 从素材库向两个作品引用同一 PNG。移除第一个作品中的节点，第二个仍可预览及字节一致地导出。验证画布导入、收藏入库、搜索标签和文件名。                         |
| IWB-03 | `genimage-workbench.test.ts`         | 播种可识别的历史真实画布，执行两次导入并重启。一个旧范围只出现一件作品，原节点、关系、特征、坐标和导出字节保持一致。                                       |
| IWB-04 | `genimage-workbench.test.ts`         | 用同一模板创建两件作品。首次打开、填槽和预览时图像模型请求数为零。同模板版本与相同解析输入产生相同计划，缺必填图时不能启动。                               |
| IWB-05 | `genimage-workbench-session.test.ts` | 为两个作品各提交一轮，切换和重启后恢复原会话、草稿和原画布。创建和冷恢复检查实际注册工具集，使用另一作品节点发起读取及修改均被拒绝。                       |
| IWB-06 | `genimage-workbench-session.test.ts` | 在浮窗输入 `E2E_IWB_COVER` 并通过回放填写模板槽位，画布立即显示相同值。展开浮窗时仍可拖动和缩放，选中节点后显示所引用的图，来回定位结果与轮次。            |
| IWB-07 | `genimage-workbench-run.test.ts`     | 分别从一句话和产品原图启动两种模板，校验请求体、内容摘要、目标模型、次数和结果关系。运行期间更换源图或切作品，迟到结果按提交时的作品和引用入账。           |
| IWB-08 | `genimage-workbench-run.test.ts`     | 控制第二步报错、结果未知和再入。已完成的上游图可复用。同一轮重复启动不多发请求。新运行保留旧候选，旧运行保留原模板版本和输入。重启后恢复状态、谱系和定稿。 |

测试先录入候选。每条完成状态由实际运行产物支撑。

## 阶段一 · 工作台、素材和可预览模板

### 任务 1 · 作品持久化和存量导入

**文件**　修改 `packages/services/src/genimage/contract.ts`、`packages/services/src/genimage/node.ts`、`packages/services/src/genimage/storage.ts`、`packages/services/src/genimage/CONTRACT.md`、`packages/desktop/src/host/index.ts`。新建 `packages/services/src/genimage/workStore.ts`。候选用例 IWB-01、IWB-03。

- [ ] 添加 IWB-01、IWB-03，用已有真实画布格式构造旧数据，断言工作台启动路径、双作品隔离和重复导入的结果。先运行验收，预期停在工作台或导入入口缺失。
- [ ] 新工作区数据使用 `genimage/workbench/v1`。`works/<workId>` 持有作品清单、保留的 `sessionId`、画布条目、版本和定稿。`listWorks` 由已提交的作品清单生成投影。`createWork` 以规范化的请求 ID 幂等，同请求参数变化返回冲突。保存、归档和画布更新复用 `withBoardLock` 及原子写入，以提交的 revision 返回结果。
- [ ] Host 统一装配本机图像服务。工作台 RPC 使用 `workId`。旧数据导入只通过 Host 解析个人范围和可定位的历史本地范围，校验源清单及图片后发布新作品，保存旧来源的稳定去重键。旧目录保持可读取。遇到中断重试时，从源身份定位已发布的作品或继续未提交的导入。复制前后的源、缩略图和原图摘要分别比对。
- [ ] IWB-03 先验证导入两次重开仍只有一件作品，再断言旧数据保留、导出字节一致。IWB-01 在任务 3 的工作台入口接通后完整执行。

### 任务 2 · 素材引用与模板计划

**文件**　修改 `packages/services/src/genimage/contract.ts`、`packages/services/src/genimage/node.ts`、`packages/services/src/genimage/CONTRACT.md`。新建 `packages/services/src/genimage/assetLibrary.ts` 和 `packages/services/src/genimage/templates.ts`。候选用例 IWB-02、IWB-04。

- [ ] 添加 IWB-02、IWB-04 的素材与模板验收。两次用模板新建并提供等价输入，断言可见计划的顺序、依赖和交付字段一致。加载、填槽和预览过程中，断言图像适配器调用数为零。
- [ ] 让原图与缩略图以 `assetId` 被工作台素材库和画布引用。保持现有字节校验、缩略图生成和原图导出路径。先发布图片，再提交引用。画布导入默认归作品，只有素材库入口导入或显式收藏才进入素材列表。移除引用后，已有版本和运行仍可读取此前固定的原图。
- [ ] 实现固定版本的「专题封面」「电商产品主图」定义。模板数据包含显式基础素材、带角色的图片/文本/枚举槽位、按序的 `stepId`、输入依赖、能力要求及交付。`resolveTemplatePlan(templateVersion, inputs)` 以已经规范化的槽位值生成计划或缺项诊断，能力要求留在计划中供执行阶段验证。
- [ ] 模板实例和槽位归作品清单。`updateTemplateInputs` 用 `workId` 和预期 revision 写同一份参数。`previewTemplatePlan` 读取该版本及槽位，返回所缺输入、实际图像引用和预计步骤。专题封面可用纯文本，电商模板的产品原图为必填。
- [ ] 接通界面后执行 IWB-02、IWB-04。补一次资产跨作品引用回放和无 Key 模板预览，确认本地路径独立工作。

### 任务 3 · 工作台界面接入

**文件**　新建 `packages/ui/src/genimage/GenImageWorkbench.tsx`。修改 `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`、`packages/ui/src/genimage/GenImageView.tsx`、`packages/ui/src/genimage/GenImagePanel.tsx`、`packages/ui/src/genimage/useGenImageLocal.ts`、`packages/ui/src/genimage/genimage.css` 和 `packages/ui/src/i18n/locales/` 的对应消息。更新候选 `genimage-native-view.test.ts`、`genimage-local-canvas.test.ts`。

- [ ] 把现有 `图像 → 默认画布` 的断言更新为 `图像 → 工作台 → 打开作品 → 画布`。保留无模型导入、原图预览、导出和显式模型调用的回归断言。
- [ ] Shell 挂载本机工作台，工作台持有当前页签及打开的 `workId`。作品页默认展示近期作品和封面，提供空白及模板建作品。素材页提供导入、搜索、预览和收藏。模板页显示用途、所需输入和预览，使用模板进入作品内填写槽位。
- [ ] 复用现有画布视图、选中图和预览组件。把数据查询和写入接到作品 ID。同一个素材选择器同时支持加入画布和填入当前槽位。保留画布发起已有文生图、导入及导出的能力，并将生成结果发布到当前作品。
- [ ] 执行 IWB-01 至 IWB-04 和更新后的画布候选，检查深浅主题、窗口尺寸、归档恢复及预览焦点。阶段完成时，可从工作台持续整理作品和模板计划。

## 阶段二 · 作品会话及本地操作

### 任务 4 · 会话身份和受限工具注册

**文件**　修改 `packages/desktop/src/host/index.ts`、`packages/services/src/zcode-agent/zcodeAgentService.ts`、`packages/shared/src/zcode-protocol/index.ts`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` 和命中同一路径的 V4 创建参数。候选 IWB-05。使用现有 CLI 工具白名单与协议测试入口。

- [ ] 在 `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts` 增加作品会话创建、恢复和工具注册约束。断言模型可见工具只包含作品能力，旧协议缺少隔离能力时拒绝创建或恢复作品会话，普通会话仍沿用原配置。运行 `pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts`。
- [ ] Host 从作品记录读取预留的 `sessionId`，在首次操作时确认或创建该持久会话。按当前会话返回绑定的作品工具配置。现有 Agent 命令、owner/lease 和 `CommandInbox` 承担输入及排队。若运行时需要 cwd，用本机应用托管目录装配，保持原有 workspace 身份规则。
- [ ] 用合作端版本明确支持的作品工具配置贯穿 V4 创建、显式恢复、冷恢复及工具注册。现有 `zcodeAgentService.ts` 的兼容路径可以省略未知 allowlist，作品会话检测到配置无法生效时拒绝受理输入。验证最终注册面同时收窄内置、外部和动态工具。作品会话通过工作台打开。
- [ ] 每次图像工具调用由 Host 根据可信会话绑定解析 `workId`，只接收当前作品可见的素材和节点。实现作品简报、槽位读取/更新、节点查询、选定稿和本地比较。用两窗口并发打开、首发丢确认及重试验证只绑定一个会话。
- [ ] 重跑 CLI 协议用例和 IWB-05。检查多窗口、应用重启和交叉作品引用拒绝的真实产物。

### 任务 5 · 画布会话浮窗

**文件**　新建 `packages/ui/src/genimage/GenImageConversationPanel.tsx`。修改 `packages/ui/src/genimage/contract.ts`、`packages/ui/src/genimage/GenImageView.tsx` 和 `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`。使用 `packages/ui/src/v4/SessionPane.tsx` 的会话呈现入口和现有草稿能力。候选 IWB-05、IWB-06。

- [ ] 添加 IWB-06，覆盖展开时继续拖动画布、收起后续聊、通过一句话填槽、改变选中项后保持已提交引用、双向定位。运行前确认挂载现有主聊天不会满足该用例。
- [ ] 由 Shell 注入绑定该作品会话的呈现入口，图像模块只消费公开的会话视图接口。画布内浮窗复用会话内容、Composer 和工具状态，作品视图持有展开状态。会话输入草稿按作品会话身份隔离。收起、切作品与重开都使用同一持久会话。
- [ ] 输入框的图像引用 chip 显示已确认的节点和角色，提交固定快照。结构化填槽调用阶段一的同一更新入口，画布基于 Host 最新 revision 展示结果。工具输出只携带简要结果和节点引用，结果卡和画布分别按 `nodeId`、`turnId` 定位。
- [ ] 跑 IWB-05、IWB-06，并检查普通会话入口与原有面板的回归。阶段完成时，作品会话可以管理简报、素材、模板参数和定稿，继续使用画布直接生成已有类型的图像。

## 阶段三 · 执行模板与真实派生

### 任务 6 · 图像适配与模板运行

**文件**　修改 `packages/services/src/genimage/adapter.ts`、`packages/services/src/genimage/node.ts`、`packages/services/src/genimage/contract.ts`、`packages/services/src/specialized-model-settings/contract.ts`、`packages/services/src/specialized-model-settings/node.ts`、`packages/ui/src/genimage/GenImagePanel.tsx`。新建 `packages/services/src/genimage/templateRuns.ts`。维护候选 `genimage-sync-replay.test.ts` 和 IWB-07、IWB-08。

- [ ] 在现有隔离回放里记录生成和编辑实际请求、来源字节和返回 PNG。用验收专用的两步模板让第二次调用使用第一步成图，控制第二步失败或结果未知。先验证目前只有无源文生图路径。运行 `pnpm exec tsx packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/genimage-sync-replay.test.ts`。
- [ ] 给已配置的适配器提供明确能力。保留同步文本生成路径，再选一个已经验证请求和返回格式的图像编辑协议接入。解析模板计划时显示哪些步骤需要真实参考图、目标模型和可用尺寸。执行前确认接收方、素材和调用次数，改变已确认条件时重新确认。用回放断言真实参考图进入编辑请求。
- [ ] `startTemplateRun` 以 `workId`、`runId`、固定计划和确认的配置受理。把解析后的槽位、源摘要和步骤写入作品。每步使用独立 `operationId` 调用统一图像命令。提交结果前核验作品和运行归属，原子追加图像节点、父节点与操作/轮次外键，再发布新 revision。会话工具和画布按钮共享该入口。
- [ ] 保存每次步骤尝试和已生成的上游节点。回放重复的 `runId` 或 `operationId` 时查询既有结果。已知失败从相同步骤开始新的尝试并复用已完成的输入。结果未知保持待核实，替代调用需要明确确认新的操作。切换当前作品、修改槽位或模板更新时，已受理记录继续使用原快照。
- [ ] 跑隔离回放及 IWB-07、IWB-08。重点看文本模板与参考图模板的请求差异、按轮分组和中途操作后的落点。证明可从生成候选改图、选定稿、导出和重启恢复。

## 整体验证与交付

- [ ] 对照规格把 IWB-01 至 IWB-08 的实际通过结果与产物逐项登记。补两个作品交替操作、断开模型配置仍可用素材、以及同一模板跨版本重开的验收证据。
- [ ] 更新实际涉及的公共契约、现有画布规格的工作台入口说明和语义图，记录真实参考图、作品工具约束和模板运行的边。按项目流程更新候选用例状态，保留通过的回放产物。
- [ ] 运行 `pnpm typecheck`、`pnpm lint`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm architecture:check --changed`。对 React 诊断复核 `rules-of-hooks` 和 `exhaustive-deps`。运行触及的 CLI 和桌面回放，分别报告现有基线、已通过证据和未验证场景。
