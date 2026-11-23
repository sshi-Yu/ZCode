# GenImage 本地开发底座

旧开发版 `0.1.0`，仅作行为参考。新工程和安装产物位于 `plugins/apps/genimage/`。本目录保留无限画布、浮窗与可派生节点的无计费示例；刷新页面会重置模拟状态。没有真实模型、密钥、工作区读写、历史持久化或会话交接实现。

## 本地浏览器预览

从 ZCode 仓库根目录执行：

```sh
node plugins/legacy/genimage-dev/genimage/scripts/dev.mjs
```

浏览器打开 `http://127.0.0.1:4786/`。只绑定环回地址，文件改动后刷新即可预览，不需安装插件。`GENIMAGE_DEV_PORT` 可换端口；`Ctrl+C` 停止服务。

## MCP 与桌面试用

从 ZCode 仓库根目录执行：

```sh
node plugins/legacy/genimage-dev/genimage/scripts/build.mjs
node --test plugins/legacy/genimage-dev/genimage/test/*-smoke.mjs
```

预览 HTTP 与插件 MCP stdio 相互独立。桌面宿主在启用插件的会话内负责启动 stdio；不用将它手动挂在终端。重新构建后，已安装副本需要按插件市场流程更新或重装，再开启新会话。

要测试 Desktop 的侧栏入口，在「插件市场 → 添加 → 添加插件市场」选择 `plugins/legacy/genimage-dev/` 的绝对路径。打开「个人 → genimage-local」安装 `genimage@genimage-local`，开启一个新的桌面本地会话，尝试「打开 GenImage 的无限画布，不要生成图片」。预期返回打开画布入口，不调用模型服务。管理入口为「设置 → 插件」。

正式功能与发布门槛见 [GenImage 设计](../../../../docs/superpowers/specs/2026-11-23-genimage-plugin-design.md)。
