---
paths:
  - 'ui/**'
---

# Cancellable Async Flows: Attempt Guard

Use the attempt guard (`ui/src/lib/attempt.ts`) for any ceremony or dialog flow the user can
cancel, retry, or navigate away from — never hand-roll `myAttempt`/counter staleness checks
(a forgotten post-await re-check caused #423).

- `attempts.begin()` starts an attempt, superseding the one in flight; `attempts.supersede()`
  invalidates without starting one (cancel/close/leave).
- Route every await that precedes a side effect through `attempt.guard(work, onDiscard?)` — it
  throws `SupersededError` once the attempt is stale, so a stale continuation cannot apply side
  effects. `onDiscard` destroys material that must not leak past a cancel (e.g. zero a decrypted
  seed).
- Gate catch/finally blocks and callbacks on `attempt.current`. `SupersededError` is only ever
  thrown once `current` is false, so `current`-gated catch blocks swallow it automatically — no
  instanceof checks.
- Awaits that must complete even after a cancel (e.g. an on-chain spend whose record must land)
  deliberately stay outside the guard, with a comment saying so.
