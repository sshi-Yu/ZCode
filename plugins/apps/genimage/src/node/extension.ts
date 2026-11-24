interface ExtensionContext {
  views: { register(id: string, definition: { entry: string }): unknown };
}

/** 页面只提出受保护意图；任务、凭据、确认和导出由可信主区宿主拥有。 */
export function activate(ctx: ExtensionContext): void {
  ctx.views.register("workspace", { entry: "./dist/canvas.html" });
}
