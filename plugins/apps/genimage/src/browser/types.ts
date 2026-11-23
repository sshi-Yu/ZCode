/** 画布域类型：布局与谱系是视图态；来源关系（sourceAssetId 语义）是唯一业务事实。 */

export type Ratio = "4:3" | "1:1" | "3:4";

export interface CanvasNode {
  id: string;
  title: string;
  prompt: string;
  /** 派生来源；原图为 null。连线全部由此派生，不从坐标或时间推断。 */
  source: string | null;
  x: number;
  y: number;
  art: number;
  ratio: Ratio;
  time: string;
}

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export type PanelId = "create" | "inspector" | "history" | "settings" | "help";

export interface PanelState {
  id: PanelId;
  /** 打开面板的触发元素；关闭时恢复焦点。 */
  trigger: HTMLElement | null;
}

export type HostStatus =
  | "standalone"
  | "connected"
  | "handshake-failed"
  | "fullscreen-denied";

export type Locale = "zh-CN" | "en";

export const NODE_WIDTH = 288;
export const NODE_HEIGHT = 370;
export const MAX_NODES = 12;
export const BRIEF_MAX_CODE_POINTS = 2000;
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 2;
