# account-model-projects

从原 Coding Plan 订阅服务拆出的已有账号模型/团队项目读取面。意图：保留官方账号已购套餐的模型资格、项目发现与必要项目 API Key 准备，同时让商业动作（购买/订单/领取）可以从服务契约独立撤下。

不变量：

- 单一 owner：pricing 请求、组织/项目补全与项目 Key 准备由同一 Host 装配内的原 BigModel/Zai Coding Plan provider 持有；本模块不建第二份实现。
- `getEnterprisePricing` 失败必须向上传播，调用方不得以空列表吞掉网络失败；`authenticated === false` 时保持原匿名分支。
- family 路由缺省为 bigmodel；zai 请求走原 Zai provider。
- 与 runtime-config 的交集只在 Host 装配点处理（同一组 provider 实例暴露两个窄接口）。
