# Swarm Identity Management

Web-based identity and key management solution for decentralized applications on the Swarm network. This repository contains the **trusted domain UI** for managing user identities, keystores, and application permissions.

See [docs/proposal.md](docs/proposal.md) for full architecture details and [docs/components.md](docs/components.md) for technical component breakdown.

## Architecture

**Trusted Domain with IFrame Model:**

- Apps load this trusted domain code in an iframe for secure key operations
- No browser extension installation required
- Encrypted keystore with hierarchical key structure (master key → app keys → resource keys)
- Supports Passkey/WebAuthn and SIWE (Sign-In with Ethereum) authentication

**Key Features:**

- Identity creation and management (personas/accounts)
- App approval and permission management
- Keystore unlocking and secure signing operations
- Encrypted wallet file stored locally (Swarm sync planned for future)

## Tech Stack

- **Frontend**: SvelteKit 2.16+ with Svelte 5 (runes)
- **Language**: TypeScript (strict mode)
- **Testing**: Vitest (unit) + Playwright (component & e2e)
- **Node**: >=22, **pnpm**: >=10

## Quick Start

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev
```

## Development Commands

```bash
pnpm dev              # Start development server
pnpm build            # Build for production
pnpm preview          # Preview production build

pnpm check            # TypeScript type checking
pnpm lint             # Run linting
pnpm format           # Auto-format code

pnpm test             # Run all tests
pnpm test:unit        # Run unit tests (Vitest)
pnpm test:ct          # Run component tests (Playwright)
pnpm test:integration # Run e2e tests (Playwright)
```

## Project Structure

- `src/lib/stores/` - Svelte 5 runes-based state management
- `src/lib/components/` - Reusable Svelte components
- `src/routes/` - SvelteKit routes (file-based routing)
- `docs/` - Architecture proposals and technical documentation

## Swarm Integration

This trusted domain UI will integrate with the Swarm network through:

- **bee-js**: Swarm JavaScript SDK for interacting with Bee nodes
- **Swarm data primitives**: Chunks, Feeds, SOCs (Single Owner Chunks), ACTs (Access Control Tries)
- **Postage stamps**: Required for uploads, proving payment for storage
- **Multiple access modes**: Full local node, gateway node, or WASM Bee in browser

## Testing

### Test Types

1. **Unit Tests** (`pnpm test:unit`) - Vitest
   - Business logic, utilities, and stores
   - Fast execution, no browser required
   - Files: `*.test.ts`

2. **Component Tests** (`pnpm test:ct`) - Playwright Component Testing
   - Individual component behavior and user interactions
   - Real browser environment with cross-browser testing (Chrome, Firefox, Safari)
   - Files: `*.ct.spec.ts`

3. **E2E Tests** (`pnpm test:integration`) - Playwright
   - Full application workflows
   - Files: `tests/*.test.ts`

### Testing Best Practices

- Use hardcoded expected values instead of regex patterns in assertions
- Test cross-browser compatibility for user interaction components
- Use `--reporter=list` to avoid HTML server for faster CI runs
- Security-critical components (authentication, key operations) must have comprehensive test coverage

## Conventions

- Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)
- Run `pnpm check` before committing
- Cryptographic operations must use established libraries (no custom crypto implementations)
- Follow principle of least privilege for key access and permissions

## Related Documentation

- [docs/proposal.md](docs/proposal.md) - Full PoC proposal with user flows and architecture
- [docs/components.md](docs/components.md) - Component breakdown and technical notes
- [docs/project_canvas.md](docs/project_canvas.md) - Research project canvas with objectives
