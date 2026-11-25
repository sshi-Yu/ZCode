# tool-model-settings

本机工具绑定唯一所有者。公共 API 见 contract.ts；仅 local desktop-continuous attachment 发布，通用 Git / Setting RPC 不消费该配置。

持久状态为独立 JSON 的 revision + Git 正式模型引用。跨进程文件锁内 CAS 并原子替换，读取失败不自动重置。候选从正式 Registry 获取；失效绑定保留。准备与确认不修改聊天默认或会话模型。一次性 confirmationId 绑定请求内容、workspace identity fallback、会话、工具 revision、正式模型配置指纹。确认重放不重发。CLI 在创建正式模型同次 lookup 核对指纹，后续用冻结实例执行。

错误：tool-model.invalid-request / revision-conflict / model-unavailable / reconfirm-required。错误信息不含原始配置与密钥。Web/手机/远端不提供本服务；不拥有 task/session、Git 提交或请求结果队列。UI 确认后只填草稿，用户另行提交。

验收见 docs/ui/tool-model-settings.md。无 App 业务单测；CLI ModelFactory 回归、桌面 E2E 与可重复本机服务验收覆盖本合同。
