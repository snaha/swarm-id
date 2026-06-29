# Multi-device integration suite

Live, many-device scenarios that drive several simulated devices of one
throwaway account through the **real** library publish → fold → restore path
against a running Bee node, stamping uploads with a real postage batch.

These are **opt-in** and **never run in CI**. They have their own Vitest config
(`lib/vitest.multi-device.config.ts`) and npm script, separate from both the
default unit suite (`pnpm test`) and the local-cluster `pnpm test:integration`.

## What it covers

| File                                   | Scenario                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `per-device-sync.test.ts`              | 2 devices: per-device feeds converge; stamp/device tombstones; §7 invariant             |
| `per-device-sync-3.test.ts`            | 3 devices: append-only roster (no clobber); fold-latency report                         |
| `partition-acquire-3.test.ts`          | 3 devices race for 2 partitions; idle-then-reacquire → no dual-acquire                  |
| `single-device-acquire-upload.test.ts` | 1 device: clean acquire → SOC upload → publish wall times                               |
| `multi-device-acquire-upload.test.ts`  | 2 devices: per-device acquire + SOC upload + publish wall times (timings)               |
| `three-device-acquire-handoff.test.ts` | 3 devices, K=2: A→p0, B→p1 upload; B idles → C takes the freed slot + uploads (timings) |

The deterministic, always-on guards for the same logic are the mocked tests in
`lib/src/sync/*.test.ts` (run in CI). This suite is the live counterpart.

## Setup

1. Copy the template and fill it in (the `.env` is gitignored):

   ```bash
   cp lib/test/multi-device/.env.example lib/test/multi-device/.env
   # set BATCH_ID and SIGNER_KEY (and BEE_URL if not the public gateway)
   ```

   `SIGNER_KEY` is the batch owner's **private key** — keep `.env` local and
   treat the batch/key as disposable.

2. Run:

   ```bash
   pnpm --filter @snaha/swarm-id test:multi-device
   # or, from the repo root:
   pnpm test:multi-device
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
