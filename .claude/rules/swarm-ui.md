---
paths:
  - "swarm-ui/**"
---

# swarm-ui Conventions

## Svelte 5 Runes

Use Svelte 5 runes for reactive state: `$state()`, `$derived()`, `$effect()`.

## Design System (Diete)

- Uses Diete design system (`swarm-ui/src/lib/components/ui/`)
- Docs: https://diete.design
- Always prefer Diete components over custom HTML elements
- Spacing: `--padding`, `--half-padding`, `--double-padding`

## Icons (Carbon Icons)

- **Always use direct imports** (barrel imports cause SSR issues):
  - Good (direct import): `import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'`
  - Bad (barrel import – causes SSR issues, do not use): `import { ArrowRight } from 'carbon-icons-svelte'`
- Browse: https://carbondesignsystem.com/guidelines/icons/library/

## Layout Components

- **Vertical** uses `--vertical-gap` (NOT `--gap`)
- **Horizontal** uses `--horizontal-gap` (NOT `--gap`)
- Alignment: `--vertical-align-items`, `--vertical-justify-content`, `--horizontal-align-items`, `--horizontal-justify-content`
- Style props passed directly: `<Divider --divider-color="black" />`

Examples:
```svelte
<Vertical --vertical-gap="var(--padding)" --vertical-align-items="start">
  <Typography>Content</Typography>
</Vertical>

<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
  <Button>Click</Button>
</Horizontal>
```

## Component Properties Over CSS

Always use component properties first, only resort to custom CSS if the property doesn't exist:
```svelte
<!-- Good -->
<Typography font="mono">code</Typography>
<Typography variant="small">small text</Typography>
<Button variant="ghost">Click</Button>

<!-- Bad -->
<Typography class="monospace">code</Typography>
<Typography style="font-size: 0.875rem;">small text</Typography>
<Button class="ghost-button">Click</Button>
```
