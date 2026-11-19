# OffPeak resident executions

Owner: conversation。此 app 层模块只包括本契约目录与相邻的 `offPeakResidentExecutions.ts`；依赖仅为 shared 协议，不接管整个 session 目录。

Host 持有当前进程内的执行关联，CLI 原 owner 持有工作清单和完成事实。注册必须来自已确认的在途执行；数据库历史 running 行不能授权注册、重新派发或取票。调用方在原 admission 成功后确认 admitted，在 owner 释放后解除关联。

生命周期事件按 task、execution、session 匹配，旧执行或已丢弃执行的迟到事件不能影响新 owner。当前执行的完成写回和票据释放仍分别等待原边界确认；本模块没有网络、数据库或额外缓存，副作用仅经注入端口执行。退役后端口不能为旧队列新取票、重放任务或核销未知历史票据。

公开入口为 contract.ts 与保留的原类文件。UI 不依赖此模块；历史展示经 OffPeak 服务的只读投影访问。四件套不引入新的业务实现或 App 单测，运行证据沿用退役设计 PCS09/12 与隔离运行验收。
