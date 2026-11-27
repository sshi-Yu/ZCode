# 图像素材、特征与预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将桌面端 GenImage 用户入口收敛为「图像」，移除生产画布模拟功能，加入本机素材导入缓存、显式图像特征提取模型配置、特征结果缓存和沉浸式原图预览。

**Architecture:** 保留内部 `genimage` 服务标识、RPC channel、测试 ID 与旧模拟目录，生产 UI 只连接真实画布目录。Host GenImage 服务是素材、节点和特征结果的唯一拥有者；Renderer 只持有相机、选中项、预览状态和未提交表单。特征模型标记在专用模型设置服务中独立于小工具模型维护，Host 通过既有本地模型运行时调用链执行显式请求。

**Tech Stack:** TypeScript, React, Electron Desktop attachment RPC, Zod, `pngjs`, existing `ImagePreviewSurface`, WDIO manual-review E2E. This is a review draft; the product specs define scope before implementation.

---

### Task 1: 收紧公共契约和模型配置边界

**Files:**
- Modify: `packages/services/src/specialized-model-settings/contract.ts`
- Modify: `packages/services/src/specialized-model-settings/node.ts`
- Modify: `packages/services/src/specialized-model-settings/CONTRACT.md`
- Modify: `packages/services/src/specialized-model-settings/contract.example.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Modify: `packages/ui/src/settings/specialized-model-settings/ToolModelMarker.tsx`
- Modify: `packages/ui/src/settings/specialized-model-settings/contract.ts`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx`
- Test: `packages/desktop/test/e2e/settings/providers/manual-review/pending/specialized-model-settings.test.ts`

- [ ] **Step 1: Write the failing regression assertions**

  Extend the existing settings review case with the accepted capability rule: a provider model with image input and text output appears as a feature-model candidate, the feature marker is independent from the utility marker, replacing/clearing it increments only its revision, and saving the marker does not make a provider request.

- [ ] **Step 2: Run the focused case and verify the new assertions fail**

  Set `ZCODE_E2E_MANUAL_REVIEW=1` and run `pnpm --filter @zcode/desktop test:e2e:serial -- --spec './test/e2e/settings/providers/manual-review/pending/specialized-model-settings.test.ts'`. Expected failure: no feature-model marker/candidate is exposed.

- [ ] **Step 3: Add the feature model contract**

  Add `FeatureModelRef`, `FeatureModelSettingsView`, `getFeatureModelSettings`, and `setFeatureModel` to the specialized settings contract. Keep `ToolModelRef` and its methods unchanged. Expose only non-secret candidate and selected model data through the attachment.

- [ ] **Step 4: Implement independent persistence and candidate filtering**

  Add `featureModel` and `featureRevision` to the locked JSON settings schema. Filter candidates to models whose input supports image and text and whose output supports text. Keep a single selected ref, reject non-candidates, use optimistic revision checks, and never resolve credentials through the public attachment. Reuse the model-row marker UI with independent selected, pending and revision state for the feature marker.

- [ ] **Step 5: Wire Host private resolution**

  Extend the private owner callback created by `packages/services/src/node.ts` and passed from `packages/desktop/src/host/index.ts` so the GenImage service can resolve the selected feature model and credential only for local desktop attachments. Do not add a renderer, remote, or mobile credential path.

- [ ] **Step 6: Update the contract docs and rerun the focused case**

  Document the independent owner, capability filter, revision rule, and no-request-on-save invariant in `CONTRACT.md` and the example. Rerun the focused E2E case and record the actual result without promoting pending coverage.

### Task 2: Add cached imported assets and feature metadata to the GenImage service

**Files:**
- Modify: `packages/services/src/genimage/contract.ts`
- Modify: `packages/services/src/genimage/storage.ts`
- Modify: `packages/services/src/genimage/image.ts`
- Modify: `packages/services/src/genimage/node.ts`
- Modify: `packages/services/src/genimage/CONTRACT.md`
- Modify: `packages/services/src/genimage/contract.example.ts`
- Test: `packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/genimage-local-canvas.test.ts`

- [ ] **Step 1: Write failing service-facing E2E assertions**

  Add coverage for selecting PNG/JPEG files, publishing cached original and PNG thumbnail bytes, creating an unparented node, reopening the same scope after deleting the source file, and rejecting a corrupt/oversized file without a node. Add assertions that import/board read/asset preview do not call the feature model.

- [ ] **Step 2: Run the focused case and verify it fails**

  Run the existing pending image-generation case with its normal desktop E2E command. Expected failure: the canvas has no import command and no persistent imported node.

- [ ] **Step 3: Extend the public GenImage contract**

  Add asset format/name metadata, `importAsset`, `extractFeatures`, and bounded feature metadata on `GenImageNode`. Import input carries scope, request ID, file name, bytes and placement; Host derives MIME from bytes. Extraction input carries scope, node ID, model revision and request ID. Results return a fresh board projection or a sanitized domain error, not secrets or raw provider responses.

- [ ] **Step 4: Implement strict image validation and thumbnail generation**

  Reuse `pngjs` for PNG decode/CRC validation and thumbnail encoding. Add bounded JPEG signature/dimension validation through the existing image-processing dependency or a dedicated adapter; do not trust the file name or MIME alone. Enforce 16 MiB, 4096-pixel longest edge, and a bounded decoded-pixel budget before publishing. Keep original bytes for supported formats and store a PNG thumbnail.

- [ ] **Step 5: Implement atomic import persistence**

  Add imported asset entries to the board manifest with content digest, MIME, dimensions, original size, thumbnail/original file references, and feature state. Use the existing board lock and staged atomic publication. Request IDs must be idempotent; a same ID with different bytes or metadata must reject. A failed file must not create a node, while earlier files in a multi-file UI submission remain committed.

- [ ] **Step 6: Implement feature extraction cache ownership**

  Store feature summary, bounded tags, feature model identity/revision, source digest, extraction status, and sanitized error in the same board manifest. Under lock, return an existing result for the same cache key or record one in-flight request; release the lock before calling the model. Reacquire the lock before publishing and discard stale results when source digest/model revision no longer matches. Never log image bytes, prompts, provider response, or feature text.

- [ ] **Step 7: Update service contract documentation and run focused engineering checks**

  Document import atomicity, byte/dimension limits, feature cache key, stale-result rule, and local-only scope. Run `pnpm architecture:check --changed` and the existing image workspace runtime-replay case; do not add an App unit-test suite.

### Task 3: Connect explicit feature extraction to the local model runtime

**Files:**
- Modify: `packages/services/src/genimage/node.ts`
- Modify: `packages/services/src/genimage/adapter.ts`
- Modify: `packages/services/src/genimage/module.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Modify if extending the workspace one-shot operation: `packages/shared/src/zcode-protocol/index.ts`, `packages/services/src/zcode-agent/zcodeAgent.ts`, `packages/services/src/zcode-agent/zcodeAgentService.ts`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`, `apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts`
- CLI regression if extending the operation: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`
- Test: `packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/genimage-local-canvas.test.ts`

- [ ] **Step 1: Add a failing provider-call assertion**

  Configure a replay feature model, trigger extraction once, assert the provider receives a bounded image input and a fixed extraction instruction, trigger it again with the same digest and model revision, and assert the provider call count remains one. Change the model revision and assert a second explicit extraction is required.

- [ ] **Step 2: Run the focused case and verify it fails**

  Run the pending GenImage case with the isolated provider replay fixture. Expected failure: no extraction command or no feature cache result.

- [ ] **Step 3: Implement a private feature-model adapter**

  Define a Host-only adapter that accepts the resolved executable model and a bounded, metadata-free derivative of the cached image. Build a fixed system/user request and validate `{summary, tags}` with strict Zod length limits. The existing workspace generation RPC accepts only text content and records requests/results as events; do not put base64 in `prompt` or use that event path unmodified. If extending the one-shot operation, add an explicitly typed, bounded PNG input and an isolated execution branch with no request/result persistence and no tools. Prove normal text generation retains its current event behavior. Use the existing runtime/model factory rather than adding a second provider client.

- [ ] **Step 4: Wire the adapter through the owner**

  Pass `resolveFeatureModel` from the specialized settings owner to `createGenImageService`, mirroring the existing private image-generation resolver. Keep model resolution and credentials outside the public RPC descriptor. Do not use the utility marker or current chat selection as fallback.

- [ ] **Step 5: Rerun the provider replay assertions**

  Run the focused E2E/replay case and verify one request for one cache key, a new request after revision change, no request on board load/preview, and safe failure without replacing prior metadata.

### Task 4: Replace the simulated UI with the Images canvas and import flow

**Files:**
- Modify: `packages/ui/src/genimage/GenImageView.tsx`
- Modify: `packages/ui/src/genimage/GenImagePanel.tsx`
- Modify: `packages/ui/src/genimage/GenImageArtwork.tsx`
- Modify: `packages/ui/src/genimage/useGenImageLocal.ts`
- Modify: `packages/ui/src/genimage/contract.ts`
- Modify: `packages/ui/src/genimage/text.ts`
- Modify: `packages/ui/src/genimage/genimage.css`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Modify: `packages/ui/src/project-sidebar/ProjectSidebarNavigation.tsx`
- Test: `packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/genimage-native-view.test.ts`

- [ ] **Step 1: Add failing UI assertions**

  Assert the sidebar and page use「图像」, no simulation/live mode switch is rendered, empty canvas exposes「导入素材」and「创建图像」, and imported cards show file name plus up to three tags. Add a test for no model configuration: import and preview remain available while extraction/create actions show their configuration entry.

- [ ] **Step 2: Run the focused view case and verify it fails**

  Run the pending native-view E2E case. Expected failure: current view still renders fixture mode and simulation controls.

- [ ] **Step 3: Make the saved real board the only UI source**

  Remove fixture mode state and fixture fallback from the production view. Load the real board once per scope, retain local camera/selection/panel drafts only, and keep drag/move calls on the existing service contract. Delete or isolate unused simulation-only UI branches without deleting the legacy storage directory.

- [ ] **Step 4: Add file selection and import admission**

  Use a browser file input with `multiple` and `accept="image/png,image/jpeg"` to receive explicitly selected `File` objects without local paths. Check each `File.size` before calling `arrayBuffer()`, submit sequentially with a stable request ID per file, add successful nodes to the board, and report counts. Do not start extraction automatically.

- [ ] **Step 5: Add card feature summary and explicit extraction actions**

  Render up to three tags on each cached card. Add `Extract features` and `Open model settings` actions to the details/preview surface. Keep the feature request disabled while a request is active and preserve old metadata after an error.

- [ ] **Step 6: Update all user-visible text and accessibility labels**

  Replace page/sidebar headings and actions: `GenImage` →「图像」, `生图` →「创建图像」, `本机模拟` → remove, `生图模型` →「图像生成模型」, and add「特征提取模型」. Keep `genimage-*` test IDs and internal identifiers. Add English equivalents through the same text map.

- [ ] **Step 7: Rerun the view case and lint the React changes**

  Run the focused desktop E2E case and `pnpm lint`. Review every new/changed hook dependency and confirm no direct platform/window access was added.

### Task 5: Build the immersive original-image preview

**Files:**
- Modify: `packages/ui/src/genimage/GenImagePanel.tsx`
- Modify: `packages/ui/src/genimage/GenImageView.tsx`
- Modify: `packages/ui/src/genimage/genimage.css`
- Reuse: `packages/ui/src/components/ai-elements/image-preview-dialog.tsx`
- Reuse: `packages/ui/src/image-preview-editor/ImagePreviewSurface.tsx`
- Test: `packages/desktop/test/e2e/workspace/image-generation/manual-review/pending/genimage-native-view.test.ts`

- [ ] **Step 1: Add failing preview assertions**

  Assert clicking a cached card opens an un-cropped full-window preview, shows filename and natural dimensions, supports zoom controls and keyboard close, and restores focus to the card. Assert the feature drawer is collapsed initially and expands without triggering extraction.

- [ ] **Step 2: Run the focused case and verify it fails**

  Run the native-view case. Expected failure: current preview is a small generic dialog without the new card focus/drawer behavior.

- [ ] **Step 3: Compose the existing preview surface**

  Use `ImagePreviewDialog`/`ImagePreviewSurface` for image transforms, bounded panning, pointer/touch behavior and download semantics. Add only GenImage-specific header/footer metadata and a responsive feature drawer; do not add a third-party gallery package.

- [ ] **Step 4: Add focus and error lifecycle**

  Preserve the trigger ref, close on `Esc`, keep the preview open on image decode errors with a visible error state, and ensure clicking image/tool controls does not close the dialog. Detail drawer open/close must not mutate canvas camera or selected node.

- [ ] **Step 5: Validate visual states**

  Run the pending case at desktop and narrow widths in light/dark themes. Check no titlebar overlap, no horizontal overflow, natural aspect ratio, readable metadata, and reduced-motion-safe transitions. Record screenshots only as manual-review evidence; do not mark coverage promoted without an accepted run.

### Task 6: Remove obsolete user-facing simulation copy and update graph/spec evidence

**Files:**
- Modify: `packages/ui/src/genimage/text.ts`
- Modify: `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts`
- Modify: `packages/ui/src/settings/specialized-model-settings/Details.tsx`
- Modify: `packages/ui/src/genimage/CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-11-26-genimage-native-view-design.md`
- Modify: `docs/superpowers/specs/2026-11-26-model-settings-images-and-tools.md`
- Modify: `docs/superpowers/specs/2026-11-27-genimage-canvas-product-design.md`
- Modify: `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`

- [ ] **Step 1: Search for stale visible terms**

  Run `rg -n 'GenImage|生图|本机模拟|模拟生成|真实生图' packages/ui/src packages/desktop/src docs/superpowers/specs` and classify each hit as internal identifier, historical spec, or user-facing text.

- [ ] **Step 2: Replace only user-facing terms**

  Update current navigation, settings labels, panel headings, notices, accessibility labels, and feature graph aliases. Keep service IDs, RPC channels, data directories, test IDs, and historical migration references unchanged.

- [ ] **Step 3: Run graph and architecture checks**

  Run `pnpm architecture:check --changed` and the repository feature-graph integrity/seed checks available in the current checkout. Fix only violations introduced by this feature.

### Task 7: Final verification and evidence report

**Files:**
- No new product files; update only the relevant pending E2E case/fixture metadata if the runner requires it.

- [ ] **Step 1: Run focused engineering tests**

  Run focused desktop E2E/manual-review cases for settings, image canvas and generation replay using `pnpm --filter @zcode/desktop test:e2e:serial -- --spec <pending-spec>`. Run the affected package's CLI protocol test if that contract changes. Do not run or add retired App business unit tests.

- [ ] **Step 2: Run mandatory repository checks**

  Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, and `pnpm architecture:check --changed`. Capture exit codes and distinguish new failures from pre-existing failures.

- [ ] **Step 3: Inspect the final diff and user-visible vocabulary**

  Run `git diff --check`, `git status --short`, and the stale-term search from Task 6. Confirm no credentials, original image bytes, provider URLs with secrets, or feature output are logged or committed.

- [ ] **Step 4: Report evidence and remaining limits**

  Summarize changed files, verified commands, actual pass/fail output, and any manual-review or environment limitations. Do not claim E2E coverage is promoted without a passing artifact path.
