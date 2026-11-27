import type { ReactNode } from "react";
export type { GenImageBoard, GenImageNode, IGenImageService } from "@zcode/services";
export { GENIMAGE_BOARD_NODE_LIMIT } from "@zcode/services";

export interface GenImageViewProps {
  windowControls?: ReactNode;
  sidebarCollapsed?: boolean;
  localScope?: string;
  localScopeName?: string;
}
