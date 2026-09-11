# Contributing to Swarm ID

Thank you for your interest in contributing to Swarm ID! This document outlines the process for contributing to this project.

## Types of Contributions

We welcome:

- Bug reports and fixes
- Feature requests and implementations
- Documentation improvements

## Issue-First Workflow

**Please open a GitHub issue before starting work on any non-trivial change.**

This helps us:

- Avoid duplicate efforts
- Ensure your contribution aligns with the project direction
- Provide guidance before you invest significant time

### Process

1. **Search existing issues** to avoid duplicates
2. **Open a new issue** describing the bug or feature
3. **Wait for feedback** from maintainers
4. **Once approved**, fork the repo and create your PR
5. **Link your PR** to the issue (e.g., "Closes #123")

For trivial changes (typos, small doc fixes), you may skip the issue step.

## Code Style

We enforce consistent code style. Before committing:

```bash
pnpm check:all  # Run all checks (format, lint, typecheck, test, knip)
```

### Style Rules

- **No semicolons**
- **Never use `null`** — use `undefined` instead
- **Never use `any`** — use proper types, generics, or `unknown`
- **kebab-case** for file and directory names
- **Format with Prettier**: `pnpm exec prettier --write <file>`

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type: short description

Optional longer description
```

### Types

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `refactor:` — Code change that neither fixes a bug nor adds a feature
- `test:` — Adding or updating tests
- `chore:` — Maintenance tasks

### Examples

```
feat: add WebAuthn passkey authentication
fix: resolve Safari storage access issue
docs: update architecture diagram
```

## Pull Requests

1. **Fork** the repository
2. **Create a branch** from `main`
3. **Make your changes** following the code style
4. **Run checks**: `pnpm check:all`
5. **Submit PR** with a clear description
6. **Link the issue** (e.g., "Closes #123")

Keep PRs small and focused on a single concern.

## Testing

- **Unit tests**: `*.test.ts` (Vitest), beside the code they cover
- **E2E and browser tests**: `tests/*.test.ts` in `ui/` and `demo/` (Playwright)
- **Integration tests**: `lib/test/integration/` (Vitest) against a local Bee cluster — run in CI
  by `integration-tests.yml`, and locally once `pnpm dev:cluster:start` is up
- **Live tests**: `lib/test/live/` and `ui/`'s `test:live` — opt-in, they self-skip without a
  configured endpoint

Run tests with:

```bash
pnpm check:all                      # Everything CI runs, including each package's tests
pnpm --filter @snaha/swarm-id test  # One package's unit tests
```

There is no `pnpm test` at the repo root — tests run per package, or through `check:all`.

## Code Review

- All PRs require review from a maintainer
- Be responsive to feedback
- Update your PR based on review comments

## License

This project is licensed under the [Apache License 2.0](LICENSE). By contributing, you agree that your contributions will be licensed under the same license.

## Questions?

Open an issue or check the [documentation](https://swarm.snaha.net/docs).
