import type { ReactNode } from "react";
export type {
  GenImageBoard,
  GenImageNode,
  IGenImageService,
  GenImageFeatures,
  FeatureModelSettingsView,
  ImageModelSettingsView,
  ImageModelView,
} from "@zcode/services";
export { GENIMAGE_ASSET_MAX_BYTES, GENIMAGE_BOARD_NODE_LIMIT } from "@zcode/services";

export interface GenImageViewProps {
  windowControls?: ReactNode;
  sidebarCollapsed?: boolean;
  localScope?: string;
  localScopeName?: string;
  onOpenModelSettings?: () => void;
}
