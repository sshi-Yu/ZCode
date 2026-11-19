# Off-Peak 闲时任务退役契约（商业服务拆除 C 阶段细化）

日期：2026-11-19
状态：实施中（分支 `refactor/personal-workbench-commercial-services`）
上位设计：`docs/superpowers/specs/2026-11-19-personal-workbench-commercial-services-design.md` §5.5/§5.6、实施计划 §4（阶段 C）。本文只细化 Off-Peak 的本地退役规则，不改变上位设计冻结的范围、保留能力与验收规则。

## 1. 退役定义

Off-Peak 云票据流程退役为**本地固定能力规则**，恒为开启，无灰度开关：

- 拒绝新增：`createTask` 不再取号、不再落库。
- 拒绝取号：`getTakeNumberAvailability` 不再发网络请求。
- 拒绝重排与新派发：`continueTask`/`updateTask`/`pauseTask` 明确失败；scheduler 不再认领 `queued` 任务；host 对非驻留执行的新派发一律 permanent 失败。
- 不自动转换：旧记录不得被改写为普通付费模型任务，也不得改写 `status` 语义。

## 2. 旧记录与状态兼容（UI 稳定合同）

- 不新增数据库列、不做迁移、不改写任何既有 `status`；`queued`/`paused`/`running`/终态按原字段保留。
- `list`/`get` 继续可读；所有任务投影 `schedulable: false`，表示“本地能力已退役，不再派发”，不代表云端已取消。
- `ZCodeOffPeakTask.canCancel?: boolean` 只读能力投影不落库：仅 `running` 且当前 resident 的 task/session/execution 身份有效匹配时为 true。旧服务缺字段按 false；UI 只能在 `canCancel === true` 时显示取消，不能根据历史 `running` 推断。
- 云端状态只反映最后观测时间；退役后不再为旧票据发起新的观测请求。
- `deleteHistory`/`deleteTask`（用户显式本地数据管理）保留；`cancelTask` 只允许当前进程可确认的 resident 原 owner。旧 queued/paused 和无 owner 的 running 拒绝取消操作，保留原状态，不据历史会话 ID 停止别的执行。
- 历史 transcript 中 `offpeak-create` 等旧工具结果继续由既有渲染路径可读。

## 3. 稳定错误码

| 入口 | 形态 |
| --- | --- |
| `createTask` | `OffPeakTaskCreateResult` 判别联合：`ok:false` + `failureStage:"client_validation"` + `errorCategory:"client_validation"` + `errorCode:"off_peak_retired"`；不抛异常、不落库、不发网络 |
| `getTakeNumberAvailability` | 本地 `{ canTakeNumber: false }`，无网络 |
| `continueTask`/`updateTask`/`pauseTask` | 抛 `Error("off_peak_retired")`，不写库、不请求 |

`offPeak/create` 协议面保留（防旧客户端），由服务层分类原样透传；CLI `OffPeakCreate` 工具注册移除后模型不可再调用。

## 4. running 收尾（原 owner 唯一授权）

- 只有当前 host 进程内 `OffPeakResidentExecutions` 登记的执行是可确认的运行实例；数据库 `running` 行本身不授权重放。
- 驻留执行沿原 owner 完成/失败/用户取消；票据续期（3102 收口）、释放等收尾必要网络保留。
- 驻留执行终态后，仅对其登记票据做一次核销（settle）；失败进入进程内重试集合，成功或 4xx 后停止。
- 重启后无可确认 owner 的旧 `running` 行：保留历史与未知结局，不重放、不标成功、不改状态；scheduler 不再执行 `recoverInterrupted` 回队。
- 归零判定：无驻留执行且无待核销票据时，专用同步定时器停止；冷启动即零驻留则不产生任何 Off-Peak 网络请求。

## 5. 专用轮询退役范围

退役后同步周期只做：

1. 驻留执行的票据交接重试（`retryPendingTickets`）。
2. 进程内待核销票据集合的补报。

不再做：全量历史终态核销扫描（`listUnsettledTerminal` outbox flush）、非终态票据批量轮询（`batchStatus`）、无票 queued 的过期收口。普通 Cron 调度、CommandInbox、tasks-index 共享资源不受影响。

## 6. 实施落点（本阶段）

- `packages/services/src/session/offPeakTaskService.ts`：admission 拒绝 + 驻留收尾周期 + 驻留登记/核销包装。
- `packages/services/src/session/offPeakResidentExecutions.ts`：导出 Registration 类型、暴露活跃计数。
- `packages/desktop/src/scheduler/index.ts`：移除 claimDue 认领、recoverInterrupted 重放、活跃计数上报。
- `packages/desktop/src/host/index.ts`：派发门（仅驻留执行可续票）+ 驻留登记走服务包装。
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`：移除 `OffPeakCreate` 注册；`OffPeakList` 只读保留。
- CLI 工具链 spec：`apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` 追加注册退役条目。

阶段 D 再清理死代码（handler/entry 导出、协议消息、mock 网关与 E2E 夹具），本阶段不移除执行通道与协议面。

## 7. 验收口径

- 新建/继续/编辑/暂停/取号在服务层与 CLI 工具面均被拒绝，且无网络请求与本地写入。
- 预置 queued/running 驻留夹具：queued 不派发；running 按原 owner 收尾；重启后不重放。
- 退役后冷启动（零驻留）无 Off-Peak 专用请求；普通 Cron 与会话输入不受影响。
