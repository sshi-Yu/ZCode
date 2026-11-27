export const NODE_WIDTH = 288;
export const NODE_HEIGHT = 312;

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export function fitCamera(
  nodes: readonly Pick<Camera, "x" | "y">[],
  width: number,
  height: number,
  initial: boolean,
): Camera {
  if (!nodes.length) return { x: width / 2, y: height / 2, scale: 1 };
  const left = Math.min(...nodes.map((node) => node.x));
  const right = Math.max(...nodes.map((node) => node.x + NODE_WIDTH));
  const top = Math.min(...nodes.map((node) => node.y));
  const bottom = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT));
  const scale = Math.max(
    0.02,
    Math.min(1, (width - 40) / (right - left), (height - 160) / (bottom - top)),
  );
  const freeWidth = width - (right - left) * scale;
  const freeHeight = height - (bottom - top) * scale;
  return {
    x: (initial ? Math.min(116, freeWidth / 2) : freeWidth / 2) - left * scale,
    y: (initial ? Math.min(84, freeHeight / 2) : freeHeight / 2) - top * scale,
    scale,
  };
}

export function zoomCamera(camera: Camera, factor: number, x: number, y: number): Camera {
  const scale = Math.min(2, Math.max(0.02, camera.scale * factor));
  const multiplier = scale / camera.scale;
  return { scale, x: x - (x - camera.x) * multiplier, y: y - (y - camera.y) * multiplier };
}
