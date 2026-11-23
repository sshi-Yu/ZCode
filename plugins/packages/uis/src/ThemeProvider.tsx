import { createContext, useContext, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { HostThemeSnapshot, HostThemeStore } from "@zcode-plugins/theme";

export const ThemeStoreContext = createContext<HostThemeStore | null>(null);

export function useHostTheme(): HostThemeSnapshot {
  const store = useContext(ThemeStoreContext);
  if (!store) throw new Error("Plugin UI components must be rendered inside ThemeProvider.");
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function themeStyle(snapshot: HostThemeSnapshot): CSSProperties {
  return {
    ...snapshot.variables,
    "--safe-area-inset-top": `${snapshot.safeAreaInsets.top}px`,
    "--safe-area-inset-right": `${snapshot.safeAreaInsets.right}px`,
    "--safe-area-inset-bottom": `${snapshot.safeAreaInsets.bottom}px`,
    "--safe-area-inset-left": `${snapshot.safeAreaInsets.left}px`,
    colorScheme: snapshot.theme,
  } as CSSProperties;
}

export function ThemeProvider({ store, children }: { store: HostThemeStore; children: ReactNode }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <ThemeStoreContext.Provider value={store}>
      <div
        className="zcode-plugins-theme"
        data-zcode-plugins-theme=""
        data-theme={snapshot.theme}
        lang={snapshot.locale}
        style={{ ...themeStyle(snapshot), display: "contents" }}
      >
        {children}
      </div>
    </ThemeStoreContext.Provider>
  );
}
