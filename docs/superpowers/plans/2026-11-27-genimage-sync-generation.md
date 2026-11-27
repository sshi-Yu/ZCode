# GenImage 同步文生图实施与验收

## 范围

在已提交的本机模拟画布上增加显式真实模式，复用保存/预览/导出能力，消费模型设置中的默认图像模型。仅支持 OpenAI Images 和同步 Base64 的单张文生图，PNG 输出。模拟、预览与真实画布互相隔离。

1. 更新产品规则和桌面 pending E2E：缺少默认模型时禁止真实提交；保留本机模拟闭环。
2. 提供 Host 内部的配置修订与私有密钥解析，不扩大 attachment/远端 RPC 权限。
3. 在短文件锁中持久化受理 ID，无锁执行有界 HTTPS 请求，短锁发布素材。中断后同 ID 不重发。
4. 增加模式入口、实际接收方/模型参数展示及错误分类。真实参考图派生暂禁用。
5. 执行零额度运行时回放、Electron 验收、构建、类型、Lint 和架构检查。

## FrostFox 测试配置

切换模式只读取本机画布，不发送生图请求。开发时修改 Host/RPC 契约后须重启 Electron 和旧的构建 watcher；Vite 热更新只能刷新 Renderer。若旧 Host 报 `getBoard` 不认识 `mode`，先用同一开发数据目录重启，不要清掉模型配置或把真实画布降级为模拟画布。

按 [FrostFox 接入文档「图片任务 (OpenAI格式)」](https://market.frostfox.ai/docs) 的示例，在桌面「设置 → 模型 → 图像」配置以下非秘密参数。当前开发 profile 重置时可以按此重新录入。

| 字段        | 值                                 |
| ----------- | ---------------------------------- |
| 显示名称    | `FrostFox · GPT Image 2 2K`        |
| API 格式    | 兼容接口 · 同步 Base64（`base64`） |
| Base URL    | `https://market.frostfox.ai/v1`    |
| 模型 ID     | `gpt-image-2-2k`                   |
| 尺寸 / 质量 | `2048x2048` / `high`               |

到 [FrostFox 密钥页](https://market.frostfox.ai/keys) 确认所用 Key 可见该模型，再在桌面设置中录入，密钥留在本机凭据库。网关使用 `POST /v1/images/generations`，固定 `n=1`，兼容模式发送 `response_format: b64_json` 并读取 `data[0].b64_json`。官方示例带可选的 `Idempotency-Key`；当前客户端依赖本机请求 ID 防止重发，不向上游发送此头。同步入口最多等待 120 秒，超时无可查询任务 ID；请不要盲目发起新任务。异步 `/v1/tasks` 与参考图不在本次测试范围。

## 2026-11-27 验收

| 检查       | 结果与边界                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 零额度回放 | `pnpm exec tsx packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/genimage-sync-replay.test.ts` 通过。两协议 HTTP 请求体、PNG/CRC 校验、401/429/5xx/重定向拒绝、私有模型投影和修订冲突、两实例同 ID 一次调用、原图一致、模拟隔离、未知结果不重发。使用 Undici MockAgent 和本机注入，不是上游计费冒烟。 |
| Electron   | 最终 `genimage-sync-reviewed-20261127` 的 `test-results.ndjson` 三条通过：未配置真实模型不可提交；受阻地址不发送，旧 ID 不重发，确认新请求才更换 ID；A → B/C → D、历史、坐标持久化、完整重启、原图预览与字节一致导出。                                                                                                         |
| 工程回归   | `pnpm test:engineering packages/desktop/test/tsupChunkIsolation.test.ts` 20/20。先观察新增 PNG 外置断言失败，修复后通过。                                                                                                                                                                                                      |
| 构建       | Desktop tsup 与 Renderer Vite 构建成功。PNG 库必须列入 desktop 运行时依赖并 external；内联 ESM 曾直接复现 `Dynamic require of "util"`，不是画布交互失败。                                                                                                                                                                      |

静态门禁：`pnpm typecheck`、Desktop `typecheck:e2e`、`pnpm architecture:check --changed` 通过；`pnpm lint` 为 498 条既有告警、0 错误，GenImage 改动无 Hooks 诊断。

早期桌面尝试分别停在回放环境缺配置、缺 E2E bridge 和 Electron 启动超时，不能作为通过证据；修复构建依赖后最终用例正常执行。旧开发 watcher 缓存的构建配置曾覆盖新 external 产物，最终重新构建并在验收期间冻结源码写入。开发服务器应重启以加载新 tsup 配置。未使用真实密钥或消耗用户额度。尚未验证真实服务端兼容性、其它操作系统、JPEG/WebP、参考图、完整任务列表/取消和异步任务恢复。

本切片新增实现保留工作区供下一次审阅；此前改动已分别提交为 `b091321b`（模型设置/Git）和 `2abae60c`（持久化模拟画布）。
