# Live (remote-backend) test suite

Opt-in scenarios that drive one or more simulated devices of a throwaway account
through the **real** library publish → fold → restore path against a **live
remote Bee backend** (default = the public gateway), stamping uploads with a real
funded postage batch.

These are **opt-in** and **never run in CI**. They have their own Vitest config
(`lib/vitest.live.config.ts`) and npm script (`test:live`), separate from both the
default mocked unit suite (`pnpm test`) and the local-cluster `pnpm test:integration`.

## What it covers

| File                                      | Scenario                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `per-device-sync.test.ts`                 | 2 devices: per-device feeds converge; stamp/device tombstones; §7 invariant         |
| `per-device-sync-3.test.ts`               | 3 devices: append-only roster (no clobber); fold-latency report                     |
| `partition-acquire-3.test.ts`             | 3 devices race for 2 partitions; idle-then-reacquire → no dual-acquire              |
| `rename-clobber.test.ts`                  | a never-renamed device must not clobber a peer's account rename                     |
| `single-device-acquire-upload.test.ts`    | timings: 1 device, clean acquire → SOC upload → publish wall times                  |
| `multi-device-acquire-upload.test.ts`     | timings: 2 devices, per-device acquire + SOC upload + publish                       |
| `three-device-acquire-handoff.test.ts`    | timings: 3 devices, K=2, full p1 handoff cycle B→C→B (A holds p0 throughout)        |
| `second-upload-delay.test.ts`             | timings: held-lease re-validation throttle (when a 2nd upload pays a gateway read)  |
| `upload-cost-breakdown.test.ts`           | timings: held-lease upload phase breakdown (op vs publish)                          |
| `idle-yield-joined-batch-restore.test.ts` | an idle yield keeps the joined-batch ledger; a peer resumes it at the acked counter |
| `teardown-rebind-joined-restore.test.ts`  | a teardown that is a REBIND keeps the ledger; the successor re-joins the secondary  |
| `cross-batch-adopt.test.ts`               | after a default switch the adopt network-seeds the new lease batch, never zero      |
| `default-batch-switch.test.ts`            | switch A→B, reload, hold past the pointer span; a takeover resumes A at its acked   |
| `aborted-join-synced-reference.test.ts`   | a join aborted before the bind leaves no synced reference (no later zero-seed)      |

The multi-batch scenarios (the last four, plus the idle-yield one) need a
**second** funded batch in `BATCH_ID_2`; they skip without it.

The deterministic, always-on guards for the same logic are the mocked tests in
`lib/src/sync/*.test.ts` (run in CI). This suite is the live counterpart.

## Setup

1. Copy the template and fill it in (the `.env` is gitignored):

   ```bash
   cp lib/test/live/.env.example lib/test/live/.env
   # set BATCH_ID and SIGNER_KEY (and BEE_URL if not the public gateway)
   ```

   `SIGNER_KEY` is the batch owner's **private key** — keep `.env` local and
   treat the batch/key as disposable.

2. Run:

   ```bash
   pnpm --filter @snaha/swarm-id test:live
   # or, from the repo root:
   pnpm test:live
   ```

Without a `.env` (no `BATCH_ID`/`SIGNER_KEY`), every suite **skips** — so the
command is safe to run unconfigured.

## Notes

- Defaults target the public gateway (`https://api.gateway.ethswarm.org/`) with
  wide timing windows (the gateway negative-caches fresh feed addresses ~50s).
  Point `BEE_URL` at a faster node and lower the `*_MS` knobs for quicker runs.
- A full run takes several minutes (gateway propagation waits + fold polling).
- `VERBOSE=1` keeps the library's `[module]` tracing; otherwise it's filtered
  so the scenario output stays readable.
