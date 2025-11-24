# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Swarm Identity Management** - A web-based identity and key management solution for decentralized applications on the Swarm network. This project implements a trusted domain with iframe-based architecture to manage user identities, keystores, and application permissions.

This codebase was forked from Kalkul (a financial portfolio app), so you may see references to Kalkul in the code - these are leftovers and should be replaced with Swarm Identity references as development progresses.

### Key Architecture (from proposal.md)

**Identity System:**

- **Trusted Domain Model**: A trusted domain (e.g., `id.ethswarm.org`) hosts keystore UI and management
- **IFrame Communication**: Apps load trusted domain code in iframe for secure communication
- **No Extension Required**: Works without browser extension installation

**Authentication Methods:**

- **Passkey/WebAuthn**: Browser-native credential flow for key management
- **SIWE (Sign-In with Ethereum)**: For users with existing Ethereum wallets
- Both produce signed challenges used as entropy for generating secret keys

**Key Storage:**

- Hierarchical structure: master key → app-specific keys → resource keys
- **Low-stakes keys** (session keys, feed keys): Can be shared with apps
- **High-stakes keys** (postage stamps, ACT keys): Extra encryption, not shared directly
- Apps request signing operations rather than accessing keys directly
- Encrypted wallet file stored locally (online Swarm sync planned for future)

## Tech Stack

- **Frontend**: SvelteKit 2.16+ with Svelte 5 (runes)
- **Language**: TypeScript (strict mode)
- **Testing**: Vitest (unit) + Playwright (component & e2e)
- **Node**: >=22, **pnpm**: >=10

## Development Commands

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview

# Type checking and linting
pnpm check              # TypeScript type checking
pnpm check:all          # Run all checks (lint, type check, knip, locales)
pnpm lint               # Run linting
pnpm format             # Auto-format code

# Testing
pnpm test               # Run all tests
pnpm test:unit          # Run unit tests (Vitest)
pnpm test:ct            # Run component tests (Playwright)
pnpm test:integration   # Run e2e tests (Playwright)

# Database (if using Supabase)
pnpm supabase start     # Start local Supabase instance
pnpm supabase stop      # Stop local Supabase
pnpm supabase db reset  # Reset database and apply migrations
```

## Project Structure

```
src/
├── lib/
│   ├── components/     # Svelte components
│   │   ├── ui/        # Reusable UI components
│   │   └── icons/     # Icon components
│   ├── stores/        # Svelte 5 runes-based state management
│   ├── routes.ts      # Route definitions
│   └── types.ts       # TypeScript type definitions
├── routes/            # SvelteKit routes (file-based routing)

scripts/               # Utility scripts
```

## Important Patterns

### Svelte 5 Runes

This project uses Svelte 5 with runes for reactive state management:

- Use `$state()` for reactive variables
- Use `$derived()` for computed values
- Use `$effect()` for side effects

### Type Safety

- TypeScript strict mode is enabled
- Always run `pnpm check` before committing
- **CRITICAL: Never use `null` in your code - always use `undefined` instead for optional/missing values**
  - Exceptions where `null` is allowed:
    - When `null` comes from external libraries or APIs (e.g., DOM methods that return `null`)
    - In Supabase/SQL-related data where `null` translates to the SQL NULL type
  - When checking for missing values, use `!value` or `value === undefined`, not `value === null`
  - **ENFORCEMENT**: Before any file edit, scan your changes for the literal `null` and replace with `undefined`
  - Return types should be `T | undefined`, never `T | null`
  - Function parameters should default to `undefined`, never `null`
- Never use `any` type - always use proper TypeScript types for type safety
  - Use generic types, union types, or `unknown` instead of `any` when needed
  - If you must accept any type, use `unknown` and type guards for safety

### Naming Conventions

- **File naming**: Use kebab-case for all file names (e.g., `user-profile.ts`, `email-template.svelte`)
- **Directory naming**: Use kebab-case for directory names (e.g., `email-templates/`, `user-settings/`)
- **Component naming**: Svelte components should use PascalCase for the component name but kebab-case for the file name (e.g., `UserProfile.svelte` → `user-profile.svelte`)

### Import Conventions

- **Never use dynamic imports**: Always use static imports at the top of the file
  - ✅ `import SupabaseAdapter from '$lib/adapters/supabase/index'` at the top of the file
  - ❌ `const adapter = await import('$lib/adapters/supabase/index')` inside a function
- **Omit file extensions**: Omit `.js` extensions in import statements
  - ✅ `import { Server } from '@modelcontextprotocol/sdk/server/index'`
  - ❌ `import { Server } from '@modelcontextprotocol/sdk/server/index.js'`

### Component Architecture

- Components in `src/lib/components/` are reusable
- Route-specific components stay in route folders
- Use composition over inheritance

### Design System (Diete)

- Uses Diete design system for UI components
- Design system components are located in `src/lib/components/ui/`
- Key components include: Typography, Button, Input, Dropdown, List, Vertical, Horizontal, etc.
- Full documentation available at https://diete.design
- Always prefer Diete components over custom HTML elements for consistency
- Use CSS custom properties (e.g., `--padding`, `--half-padding`, `--double-padding`) for spacing
- Follow Diete patterns for layout, typography, and interactions

### Icons (Boxicons)

- Icon library located in `src/lib/components/boxicons/`
- Uses Boxicons (https://boxicons.com/) - a comprehensive open-source icon set
- Icon naming convention: `bx-icon-name` for regular icons, `bxs-icon-name` for solid variants
- Icon components accept props:
  - `size` (number | string): Icon size in pixels (default: `24`)
  - `color` (string): Icon color (default: `currentColor` - inherits from parent text color)
  - `width` and `height`: Override size individually
  - All standard SVG attributes are also supported
- Usage examples:
  - `<BxInfoCircle width={16} height={16} />` - 16px info icon
  - `<BxWallet width={20} height={20} />` - 20px wallet icon
  - `<PasskeyLogo fill="#242424" width={64} height={64} />` - Custom logo with fill color
- Browse available icons at https://boxicons.com/ or in `src/lib/components/boxicons/`

### Important Layout Component Properties

- **Vertical** component uses `--vertical-gap` (NOT `--gap`)
- **Horizontal** component uses `--horizontal-gap` (NOT `--gap`)
  - Example: `<Vertical --vertical-gap="var(--padding)">` and `<Horizontal --horizontal-gap="var(--half-padding)">`
- **Alignment properties**:
  - Vertical: `--vertical-align-items` and `--vertical-justify-content`
  - Horizontal: `--horizontal-align-items` and `--horizontal-justify-content`
  - Example: `<Vertical --vertical-align-items="start">` and `<Horizontal --horizontal-align-items="center">`
- **Style properties**: CSS custom properties can be passed directly to components
  - Example: `<Divider --divider-color="black" />` instead of `<Divider style="--divider-color: black;" />`

### Prefer Component Properties Over CSS

- Diete components provide properties to achieve visual and behavioral changes
- Always use component properties first, only resort to custom CSS if the property doesn't exist
- Examples:
  - ✅ `<Typography font="mono">` instead of ❌ `<Typography class="monospace">` with custom CSS
  - ✅ `<Typography variant="small">` instead of ❌ `<Typography style="font-size: 0.875rem;">`
  - ✅ `<Button variant="ghost">` instead of ❌ `<Button class="ghost-button">` with custom CSS
- This ensures consistency with the design system and reduces custom CSS maintenance

### Pre-commit Requirements

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

## Swarm Integration Context

### Swarm Data Primitives

- **Chunks**: 4KB max payload, content-addressed or single-owner
- **Feeds**: Mutable data pointers (owner + topic → latest reference)
- **SOC (Single Owner Chunk)**: Signed chunk with identifier
- **ACT (Access Control Trie)**: Encrypted content with grantee management
- **Postage Stamps**: Required for uploads, prove payment for storage

### Network Access Modes

- **Bee node**: Full local node (Swarm Desktop, self-hosted)
- **Gateway node**: Remote access (may not be fully trusted)
- **Bee in browser**: WASM implementation (experimental)

## Related Documentation

- `docs/proposal.md`: Full PoC proposal with user flows and architecture decisions
- `docs/components.md`: Component breakdown and technical implementation notes
- `docs/project_canvas.md`: Research project canvas with business objectives and use cases

## Conventions

- Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)
- Run `pnpm check` before committing
- When replacing Kalkul references, use "Swarm Identity" or appropriate identity management terminology
