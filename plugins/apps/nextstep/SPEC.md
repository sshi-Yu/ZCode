# NextStep 应用实现规格

本应用（`plugins/apps/nextstep`，包名 `@zcode-plugins/nextstep`）实现既有 `docs/superpowers/specs/2026-11-20-nextstep-turn-footer-design.md` 的插件部分，以本次冻结的 1.5.0 契约为准；工程布局遵循 [插件工程化规格](../../../../docs/superpowers/specs/2026-11-23-plugin-workspace-design.md)。旧实现归档于 `plugins/legacy/nextstep/`，仅作行为参考，不是新应用的构建或运行依赖。宿主接线、渲染和点击发送均不属于本目录。插件不发聊天消息，不访问网络、凭据或会话数据库。

命令、存储与渲染契约不因工程迁移改变；本目录以严格 TypeScript 重写（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`，Node 类型环境 extends `plugins/tsconfig.node.json`），对外错误消息、状态机与持久化 schema 与 0.1.1 保持一致，版本升至 0.1.2。

## 契约与状态所有者

- 清单入口 `./dist/index.mjs`（`manifest/plugin.json`），`onAvailable` 激活，注册 `nextstep`。声明 `sessions.read`、`turnFooter.generate` 与协议 `sessions: 1, rows: 4`。
- 命令通过 `call.args` 接收 `readLatest | completed | refresh`；严格校验冻结锚点及 requestId/permit，不增加返回字段。
- 唯一权威存储为 `ctx.extension.dataPath/nextstep.sqlite`。异步 worker 执行 `node:sqlite`，事务分配版本，revision 从 0 的 generating 结算到 1 的终态。数据库只存锚点、请求收据、触发类型、执行者、状态、时间、实际模型、建议和固定非敏感错误码。
- `readLatest` 只读版本最大记录，绝不读取历史或调用模型。失败和 unknown 均作为最新记录保留，不回退到旧 ready。已结算记录不可变：ready 记录原样返回持久化 items，包括排序规则收紧前（0.1.0）保存的 5 条旧版本，不重新排序或截取。
- 自动完成仅在锚点没有任何版本时认领。手动刷新追加版本。同锚点仅一个 generating；每个 `(anchor, requestId)` 收据绑定首次返回的版本，包括在途合并请求，防止迟到重投新增调用。
- worker 开启数据库时更换执行代际 owner fence，将失去执行者的 generating 结算 unknown，不接管、不重发。每次新认领有独立 UUID；结算必须同时匹配执行代际 owner、claim UUID、anchor、version 和 generating。schema 使用 user_version=1；未知的较新 schema 拒绝打开，不破坏数据。
- 宿主保证全 App 单例扩展进程。同一进程按真实 dataPath 共享存储协调（`Symbol.for` 注册表跨模块换代存活），但实际 `deactivate/reload` 会立即隔离旧执行代际：同步禁止后续 history/generate 调用，事务更换 owner 并将该代际 generating 结算 unknown，发布结算通知后关闭 worker。等待中的 history 返回后不调用模型；已发出的模型结果迟到时丢弃，不覆写新版本、不重放请求。
- 编辑器卸载、切换会话不是插件 deactivate；它们只按锚点读取，已认领任务继续在插件进程后台执行。插件停用和 App 退出则按上述执行代际收口；进程崩溃由下次激活恢复 unknown。

```mermaid
sequenceDiagram
  participant Host as 宿主
  participant Plugin as 进程内 NextStep runtime
  participant DB as SQLite worker（唯一状态所有者）
  participant Model as 宿主 turnFooter
  Host->>Plugin: completed/refresh(anchor, requestId, permit)
  Plugin->>DB: BEGIN IMMEDIATE / 幂等认领
  DB-->>Plugin: COMMIT generating(version, revision=0)
  Plugin-->>Host: 返回已提交版本
  Plugin->>Host: invalidate(anchor, version, 0)
  Plugin->>Model: history({permit})（权威截止）
  Plugin->>Model: generate({permit,text,maxOutputTokens:1600})，最多一次
  Model-->>Plugin: ok + 实际模型 / failed / unknown
  Plugin->>DB: owner fence 条件结算 / COMMIT
  Plugin->>Host: invalidate(anchor, version, 1)
  Host->>Plugin: readLatest(anchor)
  Plugin->>DB: SELECT 最大 version
  Plugin-->>Host: null 或冻结结果
```

## 生成与结果验证

- 只使用 `history({permit})` 返回的 user/assistant 文本，不按当前焦点重新取历史。校验最多 40 条、总文本不超过 24000。没有用户任务或结尾助手回答时结算 empty。
- 提示词包含最新用户任务、最终回答和剩余预算内的前序消息，序列化后总长不超过 24000。文本只在内存中使用；不持久化原始历史、生成请求、permit 或模型原始输出。
- 要求模型只返回 JSON 对象 `{ "items": [{ "dimension", "label", "prompt" }] }`，提示词只要求 2–4 个不同维度。显式空数组为 empty。原始候选继续接受 2–5 条：非法 JSON、根结构、超过 5 条原始候选或只有 1 条均失败，不做修复调用。
- 局部候选验收：在原始候选中逐项严格校验字段、纯文本长度和非空值，按 trim/lowercase 去重维度；无效或重复项可被丢弃。存活的候选按概述 Unicode 码点数（`Array.from(label.trim()).length`）升序稳定排序，同长保持原始顺序；排序后截取前 4 条，最终 2–4 条为 ready，存活不足 2 条 failed。长度上限分别为 60/100/4000，拒绝额外行为字段。排序与截取只发生在新生成结算时，不触发修复或第二次模型调用。
- ID 由插件为已接受项确定性分配（锚点、版本与内容的 SHA-256，公式与 0.1.0 完全一致），不信任模型 ID；同一持久版本反复读取和重开保持一致。仅 ready 返回 items。
- ok 响应记录实际 providerId/modelId，包括输出校验失败或 empty；失败只保存插件固定错误码。history 失败为 failed；发出 generate 后抛错或响应损坏为 unknown；不重试。
- invalidate 在认领和结算提交后异步发布，不等待端口响应；通知卡住或失败不阻塞生成、不回滚、不补发生成，重新读取仍得到持久事实。

## 构建与市场交付

- `scripts/build.mjs` 调用共享脚本 `plugins/scripts/package-market.mjs` 的 `publishMarket({ appRoot, build })`：manifest 与 listing 由其复制、校验并原子发布；回调只在临时插件根下生成 `dist/index.mjs`（esbuild 打包入口，内联 content/runtime/storage 客户端）、`dist/storage.mjs`（独立 storage 模块，回归入口）与 `dist/storage-worker.mjs`（SQLite worker）。入口通过 `new URL("./storage-worker.mjs", import.meta.url)` 相对引用 worker，esbuild 不改写该 URL，运行时相对关系与 0.1.1 一致。
- 产物为 `dist/market/marketplace.json`、`dist/market/nextstep/.zcode-plugin/plugin.json` 与上述 dist 运行文件；仅依赖 Node 内建模块，市场名保留 `dev-zcode-1b53af4a`，manifest 与 listing 同步为 0.1.2。生成目录不入 Git，不含开发源码、node_modules、符号链接或另一插件文件（由 publishMarket 校验）。

## 可重复验证

`pnpm test`（等价 `node scripts/build.mjs && node --test test/*.test.ts`）先发布市场产物，再模拟宿主安装：完整复制市场到系统临时目录，再单独复制选中的 nextstep 插件；真实 SQLite 与受控宿主端口针对脱离源码树的安装入口执行归档于 `plugins/legacy/nextstep/test` 的全部回归场景，不使用网络。覆盖手动/自动竞争、在途合并的重投、重开最新失败、稳定 ID、局部候选验收、码点排序（含 emoji 与同长并列）与 5→4 截取、旧版 5 条记录原样读取、提示词 2–4 数量约束、非法输出、预算与权威历史、模块换代、崩溃恢复、owner fence、隔离和输入校验。inline 断言不替代市场安装路径：测试仅导入 `dist/market/nextstep/dist/` 下的构建产物。

桌面轮尾用例、CI/E2E 与发布路径由主仓库接线并指向新产物；本地端口和 SQLite 测试不代替桌面联调。
