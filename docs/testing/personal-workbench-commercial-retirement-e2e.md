# 个人工作台商业服务退役验收矩阵

依据：[产品设计](../superpowers/specs/2026-11-19-personal-workbench-commercial-services-design.md)、[后端合同](../superpowers/specs/2026-11-19-personal-workbench-backend-contracts.md)和[闲时退役合同](../superpowers/specs/2026-11-19-offpeak-retirement-contract.md)。本轮证据来自隔离桌面回放和离线合成夹具，不涉及真实账号或数据库。只有测试实际断言的子场景计作通过；局部请求账本不代表所有进程和域名的出网审计。移除续费入口不等于取消服务端订阅。

## 验收结果

| ID | 优先级 | 验收目标 | 本轮证据与缺口 |
| --- | --- | --- | --- |
| PCS01 | P0 | 合成账号冷启动、恢复、切换、退出；保持 OAuth 通路且不发商业请求 | **部分**：[连接切换](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-062118-018/summary.md)通过；完整登录、重启恢复和退出流程未单独跑通。 |
| PCS02 | P0 | 已有个人套餐选模、发送、重启续聊，保持模型、认证与会话 | **部分**：同一[连接切换回放](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-062118-018/summary.md)通过已有权益刷新；个人套餐发送加重启续聊未验。 |
| PCS03 | P0 | BigModel / Z.AI Team 项目发现和凭据准备；区分首次读取失败、成功空列表和选择切换 | **部分**：[桌面 PCS03](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-051457-601/summary.md)通过首次失败提示和重试，离线后端检查通过两个账号域的项目和 Key 路由。未覆盖两个账号域完整 GUI 流程、空列表和既有选择保持的全部组合。允许只读企业项目查询及必要凭据准备。 |
| PCS04 | P0 | 无套餐、过期、耗尽、认证失效时展示真实原因，不提供购买入口，自定义模型仍可用 | **部分**：[CTP-14、CTP-17](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-051457-601/summary.md)通过未连接无购买入口、按 HTTP Date 判定过期且不展示旧余额与模型；耗尽、认证失效和自定义模型回退未在同一矩阵中覆盖。 |
| PCS05 | P0 | 匿名自定义 Provider 发送并重启，保持配置和选择 | **未运行**：本轮没有专项桌面通过产物。 |
| PCS06-A | P0 | 冷启动、online、完成任务并经过原轮询周期，营销及专用交易请求和入口均不出现 | **桌面回放通过**：[任务完成回放](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-045708-676/summary.md)断言营销请求及入口未出现、用量仍可打开。仅覆盖本地 mock 账本和该 spec 的断言；匿名专用 case 未运行。 |
| PCS06-B | P0 | 保留 App 用量聚合与账号真实只读额度展示 | **部分**：[用量面板](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-045708-676/summary.md)可打开，[既有权益刷新](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-062118-018/summary.md)通过；App 汇总、两账号域额度细节未在本轮完整验收。 |
| PCS07 | P0 | 旧购买或奖励深链及已打开视图恢复时不加载商业页面、不注入账号凭据 | **未验证**：入口删除、专用预加载桥移除不证明升级后的旧打开态和深链行为。 |
| PCS08 | P0 | 已激活 Start / 既有高速卡继续可用并正常到期；无卡正常发送，不新增 draw 或 claim | **部分，桌面无卡回放失败**：[既有 Start 权益刷新](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-062118-018/summary.md)和[过期展示](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-051457-601/summary.md)通过；两次无卡回放均在团队模型菜单前置选择失败（[首跑](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-063827-166/summary.md)、[重跑](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-065003-590/summary.md)），未执行两轮发送及中途、完成态加速标识断言。未取得桌面 draw 请求账本证据；旧 Host 禁止回退到可能抽卡的方法及既有卡到期只有离线证据，既有卡实际加速发送未验。 |
| PCS09-A | P0 | 带原 ID/票据的 queued、paused 和无 owner running 冷启动/重启后只读；不重新执行、不转 Cron、不自动取消及联网核销 | **部分**：离线 service 场景覆盖历史不改写、无票据 I/O、冷启动不恢复 owner；真实隔离 SQLite 加 Electron 重启和进程级出网未验。 |
| PCS09-B | P0 | 可确认的原 resident 正常终结并停止专用定时器；错误或重复通知不重发核销 | **部分**：离线合成场景覆盖终结、取消拒绝、票据过期、重复释放、原身份隔离、提前 ACK 与本地写入重试；未在 Electron 实测原进程承接在途任务，也未验证跨启动接管（不是退役合同所承诺的行为）。 |
| PCS10 | P0 | 保留普通 Cron 的创建、选模、审批、执行及历史；保留动态工作流 | **部分**：[普通 Cron 创建和详情](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-054145-581/summary.md)、[模板布局和无闲时创建入口](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261119-063219-499/summary.md)通过。未做真实时钟触发、审批执行或动态工作流回归。 |
| PCS11 | P1 | 普通 Web、手机远控、SSH 的已有模型、RPC 退役和身份隔离 | **未运行**：桌面和离线 RPC 结果不能代替这些运行环境的验收。 |
| PCS12 | P0 | 直接调用旧 API/RPC 时明确拒绝，不创建任务、不发生相应网络或凭据 I/O；CLI 不曝光新增工具 | **离线验证通过**：后端合成脚本覆盖 27 个退役方法、公共配置缓存和旧 Host RPC；CLI `off-peak-tool.test.ts` 验证 `OffPeakCreate` 不注册及列表/历史兼容。非真实云端端到端验证。 |

## 用例处置和取证规则

- 营销任务完成与匿名用例已改为验证退役；原投放、奖励网页等正向用例退出当前测试集。`marketing-touch-entitlement.test.ts` 在隔离 mock 通过本地 fixture 控制路由预置已有权益，不调用正式的领取接口。见 PCS06、PCS08。
- 以新增取号和新派发为前提的闲时用例及专用 fixture 已移除；历史回显和原 owner 唯一收尾见 PCS09。旧抽卡命中、超时和退卡用例基于已移除的入口；原 `draw-miss` 用例改为普通发送回归，目前仍阻塞，静态 fixture 审计不算它通过。
- 请求账本只记录必要的 method/path，不记录凭据或真实内容。允许只读套餐和额度查询、Team 项目发现和必要凭据准备；不能用宽泛的 `billing` 或 `pricing` 匹配替代逐方法核查。
- 本轮为定向回放，不覆盖全量桌面套件、真实账号、生产升级、所有网络出口、旧打开态或人工跨端 GUI。测试通过的子场景保留产物链接；离线场景只为服务层提供证据。
