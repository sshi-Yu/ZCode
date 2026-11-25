import type { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
export type IToolModelSettingsService = NonNullable<
  ReturnType<typeof useBaseWorkspaceServices>["toolModelSettingsService"]
>;
export type ToolModelSettingsView = Awaited<ReturnType<IToolModelSettingsService["getView"]>>;
export type ToolModelReference = NonNullable<
  ToolModelSettingsView["bindings"][number]["selection"]
>;
export interface ToolModelDetailsProps {
  className?: string;
  onDirtyChange?: (dirty: boolean) => void;
}
