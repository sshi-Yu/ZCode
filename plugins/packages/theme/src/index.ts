export type HostTheme = "light" | "dark";
export type HostDisplayMode = "inline" | "fullscreen" | "pip";
export interface HostThemeSnapshot {
  readonly theme: HostTheme;
  readonly locale: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly safeAreaInsets: Readonly<{ top: number; right: number; bottom: number; left: number }>;
  readonly displayMode: HostDisplayMode;
  readonly containerDimensions: Readonly<Partial<Record<"width" | "height" | "maxHeight" | "maxWidth", number>>>;
}
export interface HostThemeStore {
  readonly getSnapshot: () => HostThemeSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly update: (context: unknown) => void;
}

type Validator = (value: string) => boolean;
const validators = new Map<string, Validator>();
const register = (names: readonly string[], validate: Validator): void => {
  for (const name of names) validators.set(name, validate);
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const bounded = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;

function splitCommas(value: string): string[] {
  let depth = 0;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (value[i] === "," && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
    if (depth < 0) return [];
  }
  if (depth !== 0) return [];
  result.push(value.slice(start).trim());
  return result;
}

function color(value: string, depth = 0): boolean {
  if (depth > 3) return false;
  if (/^#[\da-f]{3,4}$/i.test(value) || /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return true;
  if (/^(transparent|black|white|currentcolor)$/i.test(value)) return true;
  const mix = /^color-mix\((.*)\)$/i.exec(value);
  if (mix?.[1]) {
    const [space, a, b, ...extra] = splitCommas(mix[1]);
    const stop = (part: string | undefined): boolean => {
      if (!part) return false;
      const match = /^(.*?)\s+(\d+(?:\.\d+)?%)$/.exec(part);
      return match?.[1] && match[2] ? Number.parseFloat(match[2]) <= 100 && color(match[1], depth + 1) : color(part, depth + 1);
    };
    return extra.length === 0 && !!space && /^in (srgb|srgb-linear|oklab|oklch|lab|lch|hsl|hwb)( (shorter|longer|increasing|decreasing) hue)?$/i.test(space) && stop(a) && stop(b);
  }
  const fn = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(([^()]*)\)$/i.exec(value);
  if (!fn?.[1] || !fn[2]) return false;
  const number = "[+-]?(?:\\d*\\.)?\\d+(?:e[+-]?\\d+)?%?";
  const channels = new RegExp(`^${number}\\s+${number}\\s+${number}(?:\\s*\\/\\s*${number})?$`, "i");
  const legacy = new RegExp(`^${number}\\s*,\\s*${number}\\s*,\\s*${number}(?:\\s*,\\s*${number})?$`, "i");
  const body = fn[2].trim();
  if (!channels.test(body) && (!/^(rgb|rgba|hsl|hsla)$/i.test(fn[1]) || !legacy.test(body))) return false;
  return body.split(/[\s,/]+/).every((part) => Number.isFinite(Number.parseFloat(part)) && Math.abs(Number.parseFloat(part)) <= 10000);
}
const colorValidator: Validator = (value) => color(value);
const dimension = (value: string, max: number): boolean => {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value);
  return !!match?.[1] && Number(match[1]) * (match[2] === "rem" ? 16 : 1) <= max;
};
const fontSize: Validator = (value) => {
  if (dimension(value, 96)) return Number.parseFloat(value) * (value.endsWith("rem") ? 16 : 1) >= 8;
  const match = /^calc\((\d+(?:\.\d+)?)px\s*([+-])\s*(\d+(?:\.\d+)?)px\)$/.exec(value);
  if (!match?.[1] || !match[3]) return false;
  const result = Number(match[1]) + (match[2] === "+" ? 1 : -1) * Number(match[3]);
  return result >= 8 && result <= 96;
};
const lineHeight: Validator = (value) => /^\d+(\.\d+)?$/.test(value) ? Number(value) >= 1 && Number(value) <= 3 : dimension(value, 144);
// 宿主系统栈含 -apple-system；允许本地字体名的前导连字符，但不允许资源地址或 CSS 语句。
const fontFamily: Validator = (value) => value.split(",").every((part) => /^(?:-?[a-z][a-z\d -]*|"[a-z][a-z\d -]*"|'[a-z][a-z\d -]*')$/i.test(part.trim()));
const shadow: Validator = (value) => splitCommas(value).every((part) => {
  const match = /^((?:-?\d+(?:\.\d+)?(?:px|rem)?\s+){2,4})(.+)$/.exec(part);
  return !!match?.[1] && !!match[2] && match[1].trim().split(/\s+/).every((length) => Math.abs(Number.parseFloat(length)) <= 64) && color(match[2]);
});

for (const [group, roles] of Object.entries({
  background: ["primary", "secondary", "tertiary", "inverse", "ghost", "info", "danger", "success", "warning", "disabled"],
  text: ["primary", "secondary", "tertiary", "inverse", "ghost", "info", "danger", "success", "warning", "disabled"],
  border: ["primary", "secondary", "tertiary", "inverse", "ghost", "info", "danger", "success", "warning", "disabled"],
  ring: ["primary", "secondary", "inverse", "info", "danger", "success", "warning"],
})) register(roles.map((role) => `--color-${group}-${role}`), colorValidator);
register(["--font-sans", "--font-mono"], fontFamily);
register(["normal", "medium", "semibold", "bold"].map((role) => `--font-weight-${role}`), (value) => /^[1-9]00$/.test(value));
for (const [group, sizes] of Object.entries({ text: ["xs", "sm", "md", "lg"], heading: ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"] })) {
  register(sizes.map((size) => `--font-${group}-${size}-size`), fontSize);
  register(sizes.map((size) => `--font-${group}-${size}-line-height`), lineHeight);
}
register(["xs", "sm", "md", "lg", "xl"].map((size) => `--border-radius-${size}`), (value) => dimension(value, 32));
register(["--border-radius-full"], (value) => dimension(value, 9999));
register(["--border-width-regular"], (value) => dimension(value, 4));
register(["hairline", "sm", "md", "lg"].map((size) => `--shadow-${size}`), shadow);

function styleValue(key: string, input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  if (!value || value.length > 512 || /[;{}\\<>@]|\/\*|\*\/|url\s*\(|var\s*\(|expression\s*\(/i.test(value)) return undefined;
  return validators.get(key)?.(value) ? value : undefined;
}
function localeValue(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 64 || !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/i.test(input)) return undefined;
  try { return Intl.getCanonicalLocales(input)[0]; } catch { return undefined; }
}

/** Host context is the only accepted write path; never stores a user theme preference. */
export function createHostThemeStore(initialTheme?: string | null): HostThemeStore {
  let snapshot: HostThemeSnapshot = Object.freeze({
    theme: initialTheme === "dark" ? "dark" : "light",
    locale: "en-US",
    variables: Object.freeze({}),
    safeAreaInsets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
    displayMode: "inline",
    containerDimensions: Object.freeze({}),
  });
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (context) => {
      if (!record(context)) return;
      const variables = { ...snapshot.variables };
      const styles = own(context, "styles");
      const incoming = record(styles) ? own(styles, "variables") : undefined;
      if (record(incoming)) for (const key of Object.keys(incoming)) {
        const value = styleValue(key, incoming[key]);
        if (value !== undefined) variables[key] = value;
      }
      const safeAreaInsets = { ...snapshot.safeAreaInsets };
      const insets = own(context, "safeAreaInsets");
      if (record(insets)) for (const edge of ["top", "right", "bottom", "left"] as const) {
        const value = own(insets, edge);
        if (bounded(value, 256)) safeAreaInsets[edge] = value;
      }
      const containerDimensions = { ...snapshot.containerDimensions };
      const dimensions = own(context, "containerDimensions");
      if (record(dimensions)) for (const axis of ["width", "height", "maxHeight", "maxWidth"] as const) {
        const value = own(dimensions, axis);
        if (bounded(value, 100000)) containerDimensions[axis] = value;
      }
      const theme = own(context, "theme");
      const mode = own(context, "displayMode");
      const next: HostThemeSnapshot = {
        theme: theme === "light" || theme === "dark" ? theme : snapshot.theme,
        locale: localeValue(own(context, "locale")) ?? snapshot.locale,
        variables, safeAreaInsets,
        displayMode: mode === "inline" || mode === "fullscreen" || mode === "pip" ? mode : snapshot.displayMode,
        containerDimensions,
      };
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
      snapshot = Object.freeze({ ...next, variables: Object.freeze(variables), safeAreaInsets: Object.freeze(safeAreaInsets), containerDimensions: Object.freeze(containerDimensions) });
      for (const listener of [...listeners]) listener();
    },
  };
}
