# runtime-config

从原 Coding Plan 订阅服务拆出的公共运行配置读取面。意图：让动态工作流、模型上下文预算、请求校验与强制更新等非交易能力不再依赖订阅服务契约。

不变量：

- 单一 owner：client/configs 快照缓存、TTL、in-flight 合并与身份失效都由同一 Host 装配内的原 Coding Plan provider 持有；本模块不建第二份缓存或第二条请求路径。
- `getDynamicWorkflowClientConfig` 失败 fail-closed（disabled/default），不向调用方抛错；用户设置覆盖只在有设置权威的装配注入。
- `getModelContextBudgetStrategy` 固定返回 preflight-v1，不发网络请求。
- 与账号项目读取的交集只在 Host 装配点处理（同一 provider 实例分别暴露两个窄接口），模块之间互不依赖。
