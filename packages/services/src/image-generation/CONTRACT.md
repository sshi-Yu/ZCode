# image-generation

本机 Desktop Window Host 独占生图连接及其执行修订、私有凭据引用、任务和图库。Renderer 只保留草稿、明确确认和视口。SSH、WSL、Docker 或 Source 工作区不改变本机图库归属；手机远控及普通 Web 不发布该服务。产品约束见 [评审设计 §§3–5](../../../../docs/superpowers/specs/2026-11-25-builtin-image-generation-model-settings-design.md)，具名验收见 BI01–BI11；本契约不代表 E2E 或公网联调已通过。

```text
保存 → 配置文件锁 → 候选引用 → 加密库写入 → SQLite CAS 发布 → 回收无引用凭据
确认 → 请求 ID 匹配 → replayed（只读）
     └→ 锁内读取密钥并事务受理 → accepted → 预检网络路由 → 持久发送屏障 → 单次 POST
原图写入、fsync、rename → SQLite 发布结果 → 活动任务／分页历史／按 ID 读取预览与原图
```

- **配置。** `getConfiguration` 读取公共连接、单独修订的全局默认项和固定试生成样例；不返回凭据和引用。`saveConnection` 新建时不传 `connectionId` 并传 `expectedRevision: null`，更新时携带 ID 和预期修订；`deleteConnection`、`setDefaultSelection` 同样 CAS。连接下模型以 `modelKey` 定位，重复模型 ID 拒绝。停用／删除默认所指模型须在同一事务显式替换或清空。默认项变更不使已固定模型的确认失效。目的地绑定已规范化的 HTTPS Base URL、生成路径、探测路径、协议和鉴权；变更要求 `replace` 并输入新 Key，模型、名称等纯配置变更可 `keep`。官方预设变更目的地后不再继承官方网络策略。
- **凭据。** 密钥只在已有加密库的 Host 私有 `image-generation.` 域和执行内存，SQLite 仅持久化不可变引用。共享 RPC 注册在规范化键后对任何客户端拒绝私有键读写删。锁内先持久登记新候选再写凭据，然后 CAS 发布引用；失败不改变旧配置，启动和成功发布后回收无引用候选。受理只在锁内短暂保护凭据读取，执行不持锁。旧槽只导入固定官方项；迁移中断复用已登记的引用，提交后清理旧槽，已清除的配置不再从旧槽恢复。
- **受理。** `startGeneration` 带 request ID、连接与模型、确认修订、用途和规范化输入。先核对已登记请求，再访问当前配置；比较规范化提交参数而非模型默认合并后的执行参数。明确返回 `{ kind: "accepted", job }` 或 `{ kind: "replayed", job }`；已知请求前拒绝仍抛类型化错误。仅匹配回放，v1 旧 ID 只能用 `getRequest` 读取。遇不明确的 RPC 返回，只用同一 `requestId` 重读；没读到不代表未受理，不能因此重发或换 ID。试生成使用 Host 样例提示和版本，参数须和已确认的有效模型参数匹配；不接受试生成自定义提示。新请求按修订、启用状态和跨进程单飞事务受理，执行冻结 ID、修订、目的地指纹、模型、协议适配参数与用途。网络预检后才写发送屏障；崩溃、重放和读取永不补发。活跃 owner 根据 PID、进程令牌和跟踪集识别；不能确认另一个 PID 已退出则不抢占。正常完成和死 owner 恢复都在同一事务结算任务及试生成结果：仅当前连接修订发布最近试生成，按跨进程单飞的持久受理顺序结算，不以墙钟时间排序；读取恢复不发送请求。
- **适配器与网络。** Bearer、单张内联 PNG，`n=1` 固定。`openai-images` 沿用 `output_format=png` 和原三个尺寸／背景参数；`openai-images-b64` 固定 `response_format=b64_json`、不发送 `output_format` 或背景，仅接受省略尺寸或 `1024x1024`／`2048x2048`。质量两协议均可省略或 low/medium/high，具体供应商能力仍须验证。保存和受理合并参数后校验协议参数，拒绝不兼容组合，不能静默删调用参数；新协议使用原 request ID 作为 `Idempotency-Key`，不因此增加重发路径。协议参与目的地指纹和执行快照，变更协议需新 Key 与确认，官方预设保持原协议。固定官方 `api.openai.com:443` 生成／探测路径沿用 Host 代理、No Proxy 和 CA 策略。自定义 HTTPS 在应用代理命中但 Host 不能校验代理侧目标时拒绝；直连校验实际 DNS 候选均为允许的公网地址，以专用一次性 dispatcher 固定候选并保留原域名 TLS 和自定义 CA。任何请求拒绝重定向。回环仅限受控 Host 装配的开发／E2E 目的地，不能由公共连接草稿授权。
- **探测和结果。** `probeConnection` 显式发一次 GET，同一设置页／Window Host 的连接／模型／修订重复点击合并，不跨 Host 合并。各 Host 共享该连接持久探测序号，过时序号或修订不更新当前结果。探测上限 15 秒、256 KiB；无端点或模型未列出时为未验证，不降级生成。试生成与正式生成同一受理链，120 秒预算。发送后的断连、超时、不明确服务端失败或异常 2xx 落 `outcome_unknown`，不自动重试；已知 4xx 拒绝用本地安全诊断。RPC 只传固定错误与 `code`，不传上游正文、异常详情或密钥。
- **读取。** `readActive` 与 `readHistory` 分开；历史每页 24 条，按创建时间和持久排序键，游标固定首次上界及用途筛选；`getRequest` 是按 ID 的只读回执。`readPreview` 只接收原图资产 ID，返回上限 384px/128 KiB 的导出预览；`readImage` 只向受信任本机 Renderer 返回已成功的原始 PNG，最多 16 MiB、2048px 单边、4,194,304 像素。原图全量验证和解码，预览不改写原图。

## v1 升级和回退

先关闭旧窗口 Host，保证无活动旧写入者。升级在 `<appConfigDir>/image-generation/` 对 v1 SQLite 做一致性备份（`jobs.sqlite.v1-backup.sqlite`；已有同名时保留旧备份并另写），再事务升级，逐列保留任务、ID、原始时间、rowid 顺序、状态、原图和发送屏障。可以确认未发送的死 owner 记录结算失败，已过屏障则结算未知。一致性备份不含 PNG 和加密库；发布前备份整个图库目录以获得原图副本。

旧版无法读取 v2 SQLite。需要回退时先停止新旧 Host，另外保留升级后的完整 `image-generation/` 目录和所有原图；在确认后将 v1 备份复制为图库 `jobs.sqlite`（确保没有遗留的 WAL／SHM 来自新版），并恢复与它对应的 `assets/` 原图。旧版手动重新录入官方密钥。禁止自动覆盖升级后数据库、原图或整个加密库。
