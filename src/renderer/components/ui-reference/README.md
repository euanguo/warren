# ui-reference — shadcn download / stock baseline

**Dead code for humans and agents.** Never import from this directory in product code.

## Workflow

```text
1) shadcn add <name>
     → writes stock into src/components/ui-reference/
       (components.json aliases.ui → @/components/ui-reference)

2) bun run ui:promote <name>
     → copies stock → src/components/ui/  (skip if product file exists)
       use --force to overwrite product with fresh stock before re-applying styles

3) Edit ONLY src/components/ui/<name>.tsx
     → / product visuals (single source)

4) Product imports @/components/ui/<name>
```

## Diff

```bash
diff -u src/components/ui-reference/button.tsx src/components/ui/button.tsx
# or
bun run ui:diff
```

## Rules

- No runtime imports of `@/components/ui-reference/*`
- Do not hand-edit reference except when rebasing the stock snapshot after a clean registry pull
- `shadcn add -o` targets **reference**, not product — then promote + re-style
