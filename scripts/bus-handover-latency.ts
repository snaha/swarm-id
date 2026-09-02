// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-off measurement: how long a waiting device takes to get a partition from
 * a live holder over the account bus, against the polling fallback it replaces
 * (docs/Account-Bus.md, "Bus-accelerated leases"; #569).
 *
 * Three simulated devices in this process share one account on a two-partition
 * batch. A and B each take a partition and go idle; C then wants one. Rows:
 *
 *   free  Only A holds a partition; C claims the free one. No handover at all —
 *         the floor every other row is measured against.
 *   bus   A and B are live holders on the bus. C's slot wait broadcasts a
 *         `lease-request`; exactly one holder yields (rank election) and
 *         answers `lease-released`; C wakes and claims. The fast path.
 *   idle  Same holders, no bus. C polls; a holder's refresh tick yields after
 *         IDLE_YIELD_MS. The fallback with everyone alive.
 *   dead  Holders that never refresh, no bus. C polls until their locks lapse
 *         by TTL and their occupancy beacons age out. The fallback for a peer
 *         that vanished.
 *
 * Each row runs on a fresh account, so nothing carries over. The bus glue is a
 * copy of the proxy's three handlers (`answerLeaseRequest`, `yieldRankDelayMs`,
 * `standDownFromRequest`), which are private there; keep the rank formula
 * identical or the script measures a race the product does not have.
 *
 * Needs the local cluster and the dev signaling server (`pnpm dev:local`, or
 * `pnpm dev:cluster:start` + `pnpm dev:signaling`) and a usable batch owned by
 * the queen:
 *
 *   # amount ≥ currentPrice (GET /chainstate) × 17280 blocks × days; the queen must hold the BZZ
 *   curl -X POST localhost:1633/stamps/1244160000/20   # → batchID; "batch not usable" for ~75 s
 *   pnpm --dir scripts install   # once: tsx + bee-js for the scripts folder (not a workspace member)
 *   BATCH_ID=<batchID> SIGNER_KEY=<queen private key> pnpm --dir scripts bus-handover-latency [free] [bus] [idle] [dead]
 *
 * Optional: BEE_URL (default http://localhost:1633), SIGNALING_URL (default
 * ws://localhost:5520), DEPTH (default 20). No rows named = all four.
 *
 * Measured 2026-09-02 on the local cluster (K=2, 2 s intent window), C's
 * write call to its lease binding: free 5.3 s · bus 9.0 s (the holder's
 * `lease-released` reached C 1.4 s after its call, two stamped release writes
 * included) · idle 39.4 s · dead 48.5 s. The bus part is the ~1.4 s; the rest
 * of the bus row is the same cold claim a free partition costs.
 */

import { randomBytes } from 'node:crypto'
import { Bee, BatchId, Identifier, PrivateKey } from '@ethersphere/bee-js'
import { BatchWriteCoordinator } from '../lib/src/sync/batch-write-coordinator'
import type { CoordinatorMode } from '../lib/src/sync/batch-write-coordinator'
import {
  UtilizationAwareStamper,
  PARTITION_COUNT,
  LEASE_TTL_MS,
  LEASE_REFRESH_MS,
  IDLE_YIELD_MS,
} from '../lib/src/utils/batch-utilization'
import { PEER_YIELD_MIN_IDLE_MS } from '../lib/src/sync/batch-write-coordinator'
import { deviceHomePartition } from '../lib/src/sync/partition-lock'
import { INTENT_LIVENESS_GRACE_MS } from '../lib/src/sync/partition-intent'
import { uploadSOC } from '../lib/src/proxy/upload'
import type { UploadTarget } from '../lib/src/proxy/upload'
import { hexToUint8Array } from '../lib/src/utils/hex'
import { AccountBus } from '../lib/src/bus/account-bus'
import { SignalingTransport } from '../lib/src/bus/signaling-transport'
import { deriveBusContext } from '../lib/src/bus/bus-context'
import type { BusContext } from '../lib/src/bus/bus-context'
import type { BusMessage } from '../lib/src/bus/messages'
import { deriveAgentKeys, deviceId, delay, makeInMemoryCache } from '../lib/test/live/env'

const BEE_URL = process.env.BEE_URL ?? 'http://localhost:1633'
const SIGNALING_URL = process.env.SIGNALING_URL ?? 'ws://localhost:5520'
const DEPTH = Number(process.env.DEPTH ?? 20)
const BATCH_ID = process.env.BATCH_ID
const SIGNER_KEY = process.env.SIGNER_KEY
if (!BATCH_ID || !SIGNER_KEY) {
  console.error('BATCH_ID and SIGNER_KEY are required — see the header.')
  process.exit(1)
}

// Mirrors the proxy (`swarm-id-proxy.ts`): one rank step apart, 8-hex ids.
const PEER_YIELD_RANK_STEP_MS = 250
const LEASE_REQUEST_ID_LENGTH = 8
// Local cluster: the intent round is a fixed cost on every fresh claim with a
// known rival, so it is inside every row's number. Gateway default is 2 s too.
const INTENT_GUARD_WINDOW_MS = 2000
/** C keeps trying until a partition frees; the fallback rows need ~TTL. */
const ROW_DEADLINE_MS = 180_000

type Row = 'free' | 'bus' | 'idle' | 'dead'
const ROWS: Row[] = ['free', 'bus', 'idle', 'dead']

interface Device {
  id: string
  coordinator: BatchWriteCoordinator
  bus?: AccountBus
  transport?: SignalingTransport
  /** Wall time `onLeaseAcquired` last fired. */
  acquiredAt: number
}

const bee = new Bee(BEE_URL)
const batchID = new BatchId(BATCH_ID)
const signerKey = new PrivateKey(SIGNER_KEY)

function deviceIdForHome(prefix: string, target: number): string {
  for (;;) {
    const id = deviceId(prefix)
    if (deviceHomePartition(id, PARTITION_COUNT) === target) return id
  }
}

async function makeDevice(
  id: string,
  keys: Awaited<ReturnType<typeof deriveAgentKeys>>,
  all: string[],
  mode: CoordinatorMode,
): Promise<Device> {
  const encryptionKey = hexToUint8Array(keys.encryptionKey)
  const stamper = await UtilizationAwareStamper.create(
    signerKey.toHex(),
    batchID,
    DEPTH,
    makeInMemoryCache(),
    keys.owner,
    encryptionKey,
  )
  const device: Device = { id, coordinator: undefined as never, acquiredAt: 0 }
  device.coordinator = new BatchWriteCoordinator({
    bee,
    batchId: batchID.toHex(),
    stamper,
    deviceId: id,
    accountId: keys.accountId,
    knownDeviceIds: () => all,
    backupSigner: keys.accountKey,
    swarmEncryptionKey: encryptionKey,
    partitionCount: PARTITION_COUNT,
    mode,
    intentGuardWindowMs: INTENT_GUARD_WINDOW_MS,
    flushStamperState: () => stamper.flush(),
    onLeaseAcquired: () => {
      device.acquiredAt = Date.now()
    },
    // The proxy's `onSlotWait`: each poll round asks live holders to yield.
    onSlotWait: () =>
      device.bus?.publish({
        type: 'lease-request',
        accountId: keys.accountId,
        fromDeviceId: id,
        requestId: crypto.randomUUID().slice(0, LEASE_REQUEST_ID_LENGTH),
      }),
  })
  return device
}

/** The proxy's bus handlers, on a device: answer requests by rank, stand down
 *  on a claim, wake on a release. `onRelease` lets the waiter time the answer. */
function attachBus(
  device: Device,
  context: BusContext,
  accountId: string,
  onRelease?: (message: BusMessage) => void,
): void {
  const transport = new SignalingTransport({
    url: SIGNALING_URL,
    topic: context.topic,
    encryptionKey: context.encryptionKey,
  })
  const bus = new AccountBus([transport])
  const answered = new Set<string>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  const rankDelayMs = (requestId: string): number => {
    const partition = device.coordinator.currentPartition
    if (partition === undefined || PARTITION_COUNT <= 1) return 0
    const seed = Number.parseInt(requestId.slice(0, LEASE_REQUEST_ID_LENGTH), 16)
    return ((seed + partition) % PARTITION_COUNT) * PEER_YIELD_RANK_STEP_MS
  }
  const standDown = (requestId: string | undefined): void => {
    if (requestId === undefined) return
    answered.add(requestId)
    const timer = pending.get(requestId)
    if (timer === undefined) return
    clearTimeout(timer)
    pending.delete(requestId)
  }
  const answer = (requestId?: string): void => {
    if (requestId !== undefined) {
      if (answered.has(requestId)) return
      answered.add(requestId)
      bus.publish({
        type: 'lease-claim',
        accountId,
        fromDeviceId: device.id,
        requestId,
      })
    }
    void device.coordinator.yieldForPeer().then((partition) => {
      if (partition === undefined) return
      bus.publish({
        type: 'lease-released',
        accountId,
        partition,
        fromDeviceId: device.id,
        requestId,
      })
    })
  }

  bus.subscribe((message) => {
    if (!('fromDeviceId' in message) || message.fromDeviceId === device.id) {
      return
    }
    switch (message.type) {
      case 'lease-request': {
        const { requestId } = message
        if (requestId === undefined) {
          answer()
          return
        }
        if (pending.has(requestId) || answered.has(requestId)) return
        if (!device.coordinator.canYieldForPeer) return
        pending.set(
          requestId,
          setTimeout(() => {
            pending.delete(requestId)
            answer(requestId)
          }, rankDelayMs(requestId)),
        )
        return
      }
      case 'lease-claim':
        standDown(message.requestId)
        return
      case 'lease-released':
        standDown(message.requestId)
        device.coordinator.notifySlotMaybeFree()
        onRelease?.(message)
        return
      default:
        return
    }
  })
  device.bus = bus
  device.transport = transport
}

async function waitFor(what: string, check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(50)
  }
}

/** One SOC upload through the real write path. */
async function upload(device: Device, wait: 'block' | 'skip'): Promise<number | undefined> {
  await device.coordinator.withWrite(
    (target: UploadTarget) =>
      uploadSOC(
        target,
        new PrivateKey(randomBytes(32)),
        new Identifier(randomBytes(32)),
        randomBytes(64),
        {},
      ),
    { wait },
  )
  return device.coordinator.currentPartition
}

/** C tries until it holds a partition; the fallback rows need a TTL to lapse. */
async function acquireEventually(device: Device): Promise<number> {
  const deadline = Date.now() + ROW_DEADLINE_MS
  for (;;) {
    try {
      const partition = await upload(device, 'block')
      if (partition !== undefined) return partition
    } catch (error) {
      if (Date.now() > deadline) throw error
      console.log(`     C: ${(error as Error).message.split('\n')[0]} — retrying`)
    }
    if (Date.now() > deadline) throw new Error('C never got a partition')
    await delay(1000)
  }
}

interface Result {
  row: Row
  handoverMs: number
  acquireMs: number
  answerMs?: number
  yielder?: string
  partition: number
}

async function runRow(row: Row): Promise<Result> {
  console.log(`\n▶ ${row}`)
  const keys = await deriveAgentKeys()
  const aId = deviceIdForHome('device-a', 0)
  const bId = deviceIdForHome('device-b', 1)
  const cId = deviceId('device-c')
  const all = [aId, bId, cId]
  const holderMode: CoordinatorMode = row === 'dead' ? 'oneshot' : 'persistent'
  const A = await makeDevice(aId, keys, all, holderMode)
  const B = await makeDevice(bId, keys, all, holderMode)
  const C = await makeDevice(cId, keys, all, 'oneshot')

  let requestedAt = 0
  let answeredAt = 0
  let yielder: string | undefined
  if (row === 'bus') {
    const context = await deriveBusContext(keys.derivationKey)
    attachBus(A, context, keys.accountId)
    attachBus(B, context, keys.accountId)
    attachBus(C, context, keys.accountId, (message) => {
      if (answeredAt === 0 && message.type === 'lease-released') {
        answeredAt = Date.now()
        yielder = message.fromDeviceId
      }
    })
    // A lone context sends nothing, so wait until every socket sees the others.
    await waitFor(
      'the three devices to meet in the room',
      () => [A, B, C].every((d) => d.transport!.peerCount === 2),
      10_000,
    )
  }

  try {
    if (row === 'free') {
      console.log(`     A takes p${await upload(A, 'skip')}; B stays out`)
    } else {
      console.log(`     A takes p${await upload(A, 'skip')}, B takes p${await upload(B, 'skip')}`)
    }
    // Holders answer only once idle; give them that, plus a little.
    await delay(PEER_YIELD_MIN_IDLE_MS + 500)
    if (row === 'dead') {
      // Not torn down: a teardown releases the lease and announces it. These
      // just stop refreshing, as a closed tab does.
      console.log(`     A and B go silent; their locks lapse in ${LEASE_TTL_MS / 1000} s`)
    }

    const t0 = Date.now()
    if (row === 'bus') requestedAt = t0
    const partition = await acquireEventually(C)
    const handoverMs = Date.now() - t0
    const acquireMs = C.acquiredAt - t0
    console.log(
      `     C holds p${partition}: acquired after ${acquireMs} ms, written after ${handoverMs} ms`,
    )
    return {
      row,
      handoverMs,
      acquireMs,
      answerMs: answeredAt ? answeredAt - requestedAt : undefined,
      yielder,
      partition,
    }
  } finally {
    for (const d of [A, B, C]) {
      d.bus?.close()
      d.coordinator.teardown()
    }
  }
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a): a is Row => ROWS.includes(a as Row))
  const rows = requested.length > 0 ? requested : ROWS
  console.log(
    `bee=${BEE_URL} signaling=${SIGNALING_URL} batch=${batchID.toHex().slice(0, 12)}… K=${PARTITION_COUNT}`,
  )
  console.log(
    `TTL=${LEASE_TTL_MS} refresh=${LEASE_REFRESH_MS} idleYield=${IDLE_YIELD_MS} ` +
      `peerYieldIdle=${PEER_YIELD_MIN_IDLE_MS} beaconGrace=${INTENT_LIVENESS_GRACE_MS} intent=${INTENT_GUARD_WINDOW_MS} (ms)`,
  )
  const results: Result[] = []
  for (const row of rows) results.push(await runRow(row))

  console.log('\nrow    acquired    written    answer   yielder')
  for (const r of results) {
    console.log(
      `${r.row.padEnd(5)} ${String(r.acquireMs).padStart(7)} ms ${String(r.handoverMs).padStart(7)} ms ` +
        `${r.answerMs !== undefined ? String(r.answerMs).padStart(6) + ' ms' : '       —'}   ${r.yielder ?? '—'}`,
    )
  }
  console.log(
    "\nacquired = C's write call to its lease binding (intent round included); " +
      "written = to the call's return; answer = C's first lease-request to the lease-released it woke on.",
  )
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
