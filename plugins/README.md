# ZCode 插件开发工作区

本目录是独立的 pnpm workspace。`apps/` 是新的插件工程，`packages/` 是公共包，`legacy/` 是不参与构建的旧实现参考。工作区与 ZCode 主应用分别安装和锁定依赖。外部版本在 `pnpm-workspace.yaml` 的 `catalog` 定义；本地包通过 `workspace:*` 引用。

从仓库根执行：

```sh
pnpm -C plugins install --frozen-lockfile
pnpm -C plugins dev                  # GenImage 热更新预览
pnpm -C plugins verify               # 边界、生成文件完整性、严格类型、lint、构建及 Node 回归
pnpm -C plugins --filter @zcode-plugins/nextstep build
pnpm -C plugins --filter @zcode-plugins/genimage test:browser  # 模拟宿主，使用本机 Chrome
```

带 UI 的应用只从 `@zcode-plugins/uis` 使用组件，从 `@zcode-plugins/uis/styles.css` 加载公共样式。`ui` 的 shadcn 元组件只由固定版本 CLI 更新；业务适配写在 `uis`，宿主主题归 `theme` 校验和转换。NextStep 没有独立界面，不依赖 UI 包。

| 插件 | 市场根（相对仓库） | 完整 ID |
| --- | --- | --- |
| GenImage | `plugins/apps/genimage/dist/market` | `genimage@genimage-local` |
| NextStep | `plugins/apps/nextstep/dist/market` | `nextstep@dev-zcode-1b53af4a` |

构建后，在「插件市场 → 添加 → 添加插件市场」选择表中目录的绝对路径，而不是源码目录或单插件子目录。已登记旧本地来源的用户需要显式选择新路径；刷新旧来源不会发现新路径。不要为换址卸载现有插件。确认同名来源指向新目录后，在「个人」打开插件详情安装或更新，然后在新桌面本地会话试用。不要手动编辑宿主的安装记录。插件可在「设置 → 插件」管理。

- **GenImage：**试用「打开 GenImage 的无限画布，带入需求『一张蓝色海报』，不要生成图片」。预期打开画布、带入可编辑需求；切换宿主深浅色时不丢草稿。本版本是无计费示例，不接真实生图。
- **NextStep：**在已启用且按需授予权限的桌面本地会话完成一轮回答，查看轮尾建议并手动刷新。持久化和生成权限仍以已安装插件及当前会话为准。

NextStep 的 pending Desktop E2E 从 `dist/market/nextstep` 取安装树，回放前需先构建该 app；这条 inline 用例不等于本地市场升级验收。

旧 NextStep 源码与原市场清单已归档到 `legacy/`；旧 GenImage 已留参考副本，仍在使用的 `genimage-dev/` 原路径不会自动移除。两个旧实现均不参与新工作区构建。完整边界与退役条件见[插件工程化规格](../docs/superpowers/specs/2026-11-23-plugin-workspace-design.md)。
