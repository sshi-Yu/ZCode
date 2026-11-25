export interface WorkspaceVisibleCommandOptions {
  /** A non-interactive caller cannot ask the user to discard a settings draft. */
  confirmDiscard?: boolean;
}

export type RunAfterSettingsDraft = (
  run: () => void,
  options?: WorkspaceVisibleCommandOptions,
) => void | Promise<void>;

export type RegisterSettingsDraftGate = (gate: RunAfterSettingsDraft) => () => void;

export function runWorkspaceVisibleCommand({
  isWorkspaceVisible,
  runAfterReturningToWorkspace,
  run,
  options,
}: {
  isWorkspaceVisible: boolean;
  runAfterReturningToWorkspace?: RunAfterSettingsDraft;
  run: () => void;
  options?: WorkspaceVisibleCommandOptions;
}) {
  if (!isWorkspaceVisible && runAfterReturningToWorkspace) {
    // 返回和命令必须一起通过设置草稿门禁；仅拦返回会悄悄改变底层工作区状态。
    return runAfterReturningToWorkspace(run, options);
  }

  run();
}
