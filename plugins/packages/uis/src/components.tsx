import type { ComponentProps } from "react";
import { Button as PrimitiveButton, Input as PrimitiveInput, Textarea as PrimitiveTextarea, Label as PrimitiveLabel, DialogContent as PrimitiveDialogContent, DialogTitle as PrimitiveDialogTitle, DialogDescription as PrimitiveDialogDescription, DialogFooter as PrimitiveDialogFooter } from "@zcode-plugins/ui";
import { themeStyle, useHostTheme } from "./ThemeProvider";

export { Dialog, DialogTrigger, DialogClose, DialogHeader } from "@zcode-plugins/ui";
const classes = (...values: (string | undefined)[]): string => values.filter(Boolean).join(" ");
type ButtonProps = ComponentProps<typeof PrimitiveButton>;
const buttonSizes = {
  default: "h-7 px-2 gap-1.5",
  xs: "h-5 px-1.5 gap-1",
  sm: "h-6 px-2 gap-1",
  lg: "h-8 px-3 gap-2",
  icon: "size-7",
  "icon-xs": "size-5",
  "icon-sm": "size-6",
  "icon-lg": "size-8",
} satisfies Record<NonNullable<ButtonProps["size"]>, string>;

export function Button({ className, size = "default", ...props }: ButtonProps) {
  return <PrimitiveButton size={size} className={classes("zcode-ui-button rounded-lg text-ui-base", buttonSizes[size ?? "default"], className)} {...props} />;
}
export function Input({ className, ...props }: ComponentProps<typeof PrimitiveInput>) {
  return <PrimitiveInput className={classes("zcode-ui-input h-9 rounded-lg text-ui-base md:text-ui-base", className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<typeof PrimitiveTextarea>) {
  return <PrimitiveTextarea className={classes("zcode-ui-input rounded-lg text-ui-base md:text-ui-base", className)} {...props} />;
}
export function Label({ className, ...props }: ComponentProps<typeof PrimitiveLabel>) {
  return <PrimitiveLabel className={classes("zcode-ui-label text-ui-base", className)} {...props} />;
}

// 生成组件把 Portal 放到 body；将同一快照作用于浮层根，避免脱离 Provider 后丢失主题和语言。
export function DialogContent({ className, style, ...props }: ComponentProps<typeof PrimitiveDialogContent>) {
  const snapshot = useHostTheme();
  return <PrimitiveDialogContent data-zcode-plugins-theme="" data-theme={snapshot.theme} lang={snapshot.locale} className={classes("zcode-plugins-theme zcode-ui-dialog rounded-2xl text-ui-base", className)} style={{ ...themeStyle(snapshot), ...style }} {...props} />;
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof PrimitiveDialogTitle>) {
  return <PrimitiveDialogTitle className={classes("text-ui-base", className)} {...props} />;
}
export function DialogDescription({ className, ...props }: ComponentProps<typeof PrimitiveDialogDescription>) {
  return <PrimitiveDialogDescription className={classes("zcode-ui-description text-ui-sm", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: ComponentProps<typeof PrimitiveDialogFooter>) {
  return <PrimitiveDialogFooter className={classes("rounded-b-2xl", className)} {...props} />;
}
