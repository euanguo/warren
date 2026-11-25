# components/ui — product visuals (single source)

**完整设计语言（无实机对照时用）：** [`docs/ui-design-language.md`](../../../../docs/ui-design-language.md)

Import from **`@/components/ui/*`**.  
Stock baseline: `src/renderer/components/ui-reference` (shadcn download only — **never import**).

## Contract (default for every component)

**Corner profile:** uses `corner-shape: superellipse(1.5)` with the radius ladder. Matching only `border-radius` px still looks rounder — always keep superellipse on chrome (pills/avatars stay `round`).

## Contract details

1. **Tokens first** — geometry/color from `@/theme/theme-tokens.css` (`--control-*`, surfaces, elevation). No raw `h-8` / hex in product recipes.
2. **Shared recipes** — compose `@/theme/surface` (`controlFieldClass`, `elevatedMenuSurfaceClass`, `elevatedTooltipSurfaceClass`, …). Do not re-invent field/menu/tooltip chrome per file.
3. **DEFAULT size** — omit `size` at call sites. Ladder steps exist only for rare density scale.
4. **Token-driven DEFAULT** — DEFAULT geometry comes from the shared control ladder. Changing a token updates every consumer.

## Control ladder

| Step     | px       | Semantic DEFAULT                      |
| -------- | -------- | ------------------------------------- |
| 2xs      | 20       | dense icon                            |
| icon     | 28       | **IconButton DEFAULT**                |
| sm       | 26       | roomy toolbar icon                    |
| md       | 29       | compact row / dense field             |
| lg       | 32       | **Button / Toggle / Tabs DEFAULT**    |
| field→32 | = button | **Input / Select / Textarea DEFAULT** |

Pads / radii: `--control-pad-*`, `--control-radius*`.

## Recipe map

| Concern                | Recipe / token                                                   |
| ---------------------- | ---------------------------------------------------------------- |
| Text button            | `Button` → `--control-height` + pad/radius                       |
| Icon button            | `IconButton` → `--control-height-icon` + transparent border      |
| Field                  | `controlFieldClass` (Input, Select, Textarea)                    |
| Dense field            | `controlFieldCompactClass` (toolbar selects via className)       |
| Menu / select popup    | `elevatedMenuSurfaceClass`                                       |
| Tooltip / shortcut tip | `elevatedTooltipSurfaceClass` (solid + 1px border, **no arrow**) |
| Focus                  | `controlFocusClass` (blue hairline, no ring bloom)               |
| Menu item              | `menuItemInteractiveClass`                                       |

## Workflow

```bash
npx shadcn@latest add <name>   # → ui-reference
npm run ui:promote <name>
# restyle in components/ui using tokens + surface recipes
```

**Never** wait for a per-component request: any new/changed control must ship already on this contract.
