# Swarm Identity Management

## Overview

Web-based identity and key management solution for decentralized applications on the Swarm network.

### Architecture

- **Trusted Domain Model**: A trusted domain (e.g., `id.ethswarm.org`) hosts keystore UI and management
- **IFrame Communication**: Apps load trusted domain code in iframe for secure communication
- **No Extension Required**: Works without browser extension installation

### Authentication Methods

- **Passkey/WebAuthn**: Browser-native credential flow for key management
- **SIWE (Sign-In with Ethereum)**: For users with existing Ethereum wallets

### Key Storage

- Hierarchical structure: master key → app-specific keys → resource keys
- **Low-stakes keys** (session keys, feed keys): Can be shared with apps
- **High-stakes keys** (postage stamps, ACT keys): Extra encryption, not shared directly

### Swarm Data Primitives

- **Chunks**: 4KB max payload, content-addressed or single-owner
- **Feeds**: Mutable data pointers (owner + topic → latest reference)
- **SOC (Single Owner Chunk)**: Signed chunk with identifier
- **ACT (Access Control Trie)**: Encrypted content with grantee management
- **Postage Stamps**: Required for uploads, prove payment for storage

## Packages

- **lib/**: TypeScript library (@swarm-id/lib) for authentication and Bee API operations
- **swarm-ui/**: SvelteKit identity management UI (trusted domain)
- **demo/**: Demo dApp showing library integration examples
- **docs-site/**: Starlight (Astro) documentation website

## Reference Repositories

- **bee/**: The Bee project Go source code
- **bee-js/**: Custom fork with encrypted streaming chunk uploads
- **swarm-cli/**: Swarm CLI tool

## Documentation

- **README.md**: Full project docs, architecture, deployment
- **docs/**: Proposals and research documents
  - Swarm-Identity-Management-Proposal.md
  - Multi-Device-Stamp-Coordination-Research.md
  - DEPLOYMENT.md
- **The-Book-of-Swarm.pdf**: Comprehensive Swarm documentation

Each package folder contains its own README.md with package-specific documentation.

## Code Style

### General

- **TypeScript Execution**: Use `pnpx tsx` instead of `npx ts-node`
- **No semicolons** - follow the no-semicolon style
- **Conventional commits**: `feat:`, `fix:`, `docs:`, etc.

### Type Safety

- **Never use `null`** - always use `undefined` for optional/missing values
  - Exception: When `null` comes from external libraries or APIs
  - Return types should be `T | undefined`, never `T | null`
- **Never use `any`** - use proper TypeScript types, generics, union types, or `unknown`

### Import Conventions

- **Never use dynamic imports**: Always use static imports at the top of the file
  - ✅ `import Foo from '$lib/foo'` at top of file
  - ❌ `const foo = await import('$lib/foo')` inside a function
- **Omit file extensions** in import statements

### Constants

- **Use constants instead of hardcoded numbers**: Always define magic numbers as named constants
  - ❌ Bad: `setTimeout(() => {...}, 5000)` or `if (value > 100)`
  - ✅ Good: `const TIMEOUT_MS = 5000; setTimeout(() => {...}, TIMEOUT_MS)`
  - Exceptions: 0, 1, -1, and 2 are acceptable when meaning is obvious
  - Use SCREAMING_SNAKE_CASE for constant names

## Naming Conventions

- **File naming**: Use kebab-case for all file names (e.g., `user-profile.ts`, `email-template.svelte`)
- **Directory naming**: Use kebab-case for directory names (e.g., `email-templates/`, `user-settings/`)

## swarm-ui Specific

### Svelte 5 Runes

This project uses Svelte 5 with runes for reactive state management:

- Use `$state()` for reactive variables
- Use `$derived()` for computed values
- Use `$effect()` for side effects

### Design System (Diete)

- Uses Diete design system for UI components (`swarm-ui/src/lib/components/ui/`)
- Full documentation at https://diete.design
- Always prefer Diete components over custom HTML elements
- Use CSS custom properties for spacing: `--padding`, `--half-padding`, `--double-padding`

### Icons (Carbon Icons)

- Library: `carbon-icons-svelte`
- **Always use direct imports**:
  - ✅ `import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'`
  - ❌ `import { ArrowRight } from 'carbon-icons-svelte'` (causes SSR issues)
- Browse icons at https://carbondesignsystem.com/guidelines/icons/library/

Usage examples:
```svelte
<Information size={20} />
<Wallet size={20} />
<ArrowRight size={16} />
<Copy size={20} />
<Checkmark size={20} />
```

### Layout Components

- **Vertical** uses `--vertical-gap` (NOT `--gap`)
- **Horizontal** uses `--horizontal-gap` (NOT `--gap`)
- Alignment: `--vertical-align-items`, `--vertical-justify-content`, `--horizontal-align-items`, `--horizontal-justify-content`
- Style properties can be passed directly: `<Divider --divider-color="black" />`

Examples:
```svelte
<Vertical --vertical-gap="var(--padding)" --vertical-align-items="start">
  <Typography>Content</Typography>
</Vertical>

<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
  <Button>Click</Button>
</Horizontal>
```

### Component Properties Over CSS

Always use component properties first, only resort to custom CSS if the property doesn't exist:
```svelte
<!-- ✅ Good -->
<Typography font="mono">code</Typography>
<Typography variant="small">small text</Typography>
<Button variant="ghost">Click</Button>

<!-- ❌ Bad -->
<Typography class="monospace">code</Typography>
<Typography style="font-size: 0.875rem;">small text</Typography>
<Button class="ghost-button">Click</Button>
```

## Pre-commit Requirements

**IMPORTANT**: Before committing any changes, you MUST run and pass:

- `pnpm format` - Formats code with Prettier
- `pnpm lint` - Checks code style and quality with ESLint and Prettier
- `pnpm check` - Runs Svelte Kit sync and TypeScript type checking
- `pnpm knip` - Finds unused files, dependencies, and exports

**Quick check**: Use `pnpm check:all` to run all the above checks at once (used in CI).

## Testing Best Practices

- **Unit tests** (`*.test.ts`): Business logic, utilities, stores (Vitest)
- **Component tests** (`*.ct.spec.ts`): Component behavior in real browsers (Playwright)
- **E2E tests** (`tests/*.test.ts`): Full application workflows (Playwright)
- Use hardcoded expected values instead of regex patterns in assertions
- Test cross-browser compatibility for user interaction components
- Run `pnpm check` before committing
