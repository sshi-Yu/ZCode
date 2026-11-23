# Shared plugin theme and UI contract

This implements the approved plugin workspace design without importing host private code.

## Ownership and public surface

`theme` owns one immutable, synchronous projection of the latest valid host context. It has no React, DOM, persistence, theme preference, or host write-back. `createHostThemeStore(initialTheme?: string | null)` returns stable `getSnapshot`, `subscribe(listener)` (unsubscribe function), and `update(context: unknown)` methods. Updates accept the host context object itself, not an RPC envelope. The snapshot contains `theme`, `locale`, accepted `variables`, `safeAreaInsets`, `displayMode`, and `containerDimensions`.

```text
HTML data-theme → initial store snapshot
MCP initialize.hostContext ─┐
partial host-context-changed ┴→ validate/merge → stable snapshot → subscribers
                                                   ↓
                                   uis Provider (no child remount)
```

Only `light`/`dark` are themes; initial invalid/missing values fall back to light. Locale defaults to `en-US`. Valid partial updates replace only provided, validated fields; invalid values preserve the last valid value (or the bounded default if none). Variables merge individually. Missing/null/invalid payloads are no-ops. Same-value updates preserve snapshot identity and do not notify. Unsubscribe is idempotent. Snapshots and nested objects are frozen. The store accepts only own properties of plain records.

## Validation and presentation

Accepted style names are the MCP Apps public keys currently provided by the host's `pluginUiStyleVariables.ts`: color backgrounds/text/borders/rings, system font families, font sizes/weights/line heights, radii, border width and shadows. Values have bounded lengths and property-specific syntax. URLs, CSS statements, escapes, comments, arbitrary custom properties, `var()` and external font resources are rejected. Colors allow host hex, rgb/hsl/oklch/lab and color-mix forms. Numeric dimensions and insets are finite/bounded. Font stacks may reference locally available fonts but cannot fetch resources. No raw host parameter is spread into DOM styles.

`uis` exclusively maps accepted MCP variables to host semantic and shadcn tokens. Its Provider adds a display-contents root with data-theme/lang, never keys children by theme, and scopes all tokens to the root. Provider-backed Dialog portal content projects the same store snapshot onto its floating root, because CLI-generated DialogContent owns its body portal. App draft/canvas state remains owned by the App. CSS supplies semantic light/dark fallbacks, UI font scale, reduced-motion overrides, and no external font import. Root `html` font size is not mutated.

The public semantic CSS properties (`--color-background`, `--color-card`, `--color-popover`, `--color-input`, `--color-foreground` and its hierarchy, `--color-border`, `--color-primary`, `--color-primary-foreground`, `--color-secondary`, `--color-hover`, `--color-selected`, and semantic feedback) must be present on every Provider/portal theme root for ordinary `var()` consumers, regardless of Tailwind utility discovery. `@theme inline` alone is not that contract. Public wrappers must preserve their intended text and fill colors even when the unmodified CLI class merger cannot recognize `text-ui-*` as font size. A computed-style browser assertion must cover public properties and primary Button foreground/background in light and dark.

`ui` is CLI-owned generated code. Only `uis` consumes it; generated source is never edited. `pull-inventory.json` records CLI, registry/preset, commands and source hashes. `uis` wraps generated controls to apply DESIGN.md typography, sizing, radius and input semantics without changing generated files.

## Reproducible acceptance

- `pnpm --filter @zcode-plugins/theme test`: initial theme, partial merge, deduplication, invalid payloads/values, unsubscribe, immutable snapshots, locale and bounded context.
- `pnpm --filter @zcode-plugins/ui verify:generated`: generated source hashes match the actual CLI pull.
- `pnpm --filter @zcode-plugins/uis build:acceptance`: real React/Tailwind consumer compiles.
- With that server running, `pnpm --filter @zcode-plugins/uis test:browser <existing-chromium-executable> [url]` uses the catalog-pinned Playwright to assert computed semantic properties/primary colors in 390px/1200px × light/dark, no stale html-dark leakage, draft preservation, invalid update, portal locale/theme, Escape focus restoration, semantic partial update, reduced motion, and zero runtime errors. It does not download a browser.
- `pnpm --filter @zcode-plugins/uis dev:acceptance`: browser fixture at its printed URL. Type a draft, open the dialog, switch simulated host theme/locale, and send invalid context. Draft and mount count remain unchanged, dialog inherits tokens/lang, invalid styles are absent. Verify light/dark at 390px and 1200px, keyboard focus and reduced motion. The fixture is development-only; production exposes no competing theme switch.
