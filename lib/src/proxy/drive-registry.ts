// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The write path of each granted drive a proxy session writes to, by batch id
 * (#862): its stamp, and the stamper and coordinator built from it. The
 * primary's is built when the session resolves it; any other's on its first
 * write (`writePathFor`), since each costs a lane. An entry goes as a unit
 * when its stamp changes or leaves the grant (`reconcile`).
 *
 * The proxy keeps what depends on the rest of the session: which stamps the
 * app may use, the account they belong to, the coordinator wired to the
 * account bus, and the per-batch state it drops when a drive goes.
 */

import { BatchId, type EthAddress } from "@ethersphere/bee-js"
import { SwarmIdError } from "../errors"
import type { BatchWriteCoordinator } from "../sync/batch-write-coordinator"
import type { PostageStamp } from "../types"
import { UtilizationStoreDB } from "../storage/utilization-store"
import { UtilizationAwareStamper } from "../utils/batch-utilization"
import { uint8ArrayToHex } from "../utils/hex"
import { sameStampLifetime } from "../utils/stamp-lifespan"
import { isScratchDrive } from "../utils/postage-stamp-association"
import { DriveWritePath } from "./drive-write-path"

/** The account a drive's stamper and coordinator are built for. */
export interface DriveAccount {
  owner: EthAddress
  encryptionKey: Uint8Array
  accountId: string
  partitionCount: number
}

export interface DriveRegistryHost {
  /** The stamps the app may write with, and its primary. */
  lookupDrivesForApp(): {
    primary: PostageStamp | undefined
    granted: PostageStamp[]
  }
  lookupAccountForApp(): Promise<DriveAccount | undefined>
  /** The coordinator that writes `drive` through `stamper`. */
  createCoordinator(
    drive: DriveWritePath,
    stamper: UtilizationAwareStamper,
    account: DriveAccount,
  ): BatchWriteCoordinator
  /** `batchId`'s write path is going: drop what is kept for it. */
  onTeardown(batchId: string): void
}

export class DriveRegistry {
  private readonly drives = new Map<string, DriveWritePath>()
  /** The primary drive's batch: where a write that names no drive goes. */
  private primaryBatchId: string | undefined
  private utilizationStore: UtilizationStoreDB | undefined

  constructor(private readonly host: DriveRegistryHost) {}

  /** The primary drive's write path, if the session has one. */
  get primary(): DriveWritePath | undefined {
    return this.primaryBatchId === undefined
      ? undefined
      : this.drives.get(this.primaryBatchId)
  }

  get(batchId: string): DriveWritePath | undefined {
    return this.drives.get(batchId)
  }

  all(): DriveWritePath[] {
    return [...this.drives.values()]
  }

  /**
   * Brings the write paths in line with the grant. Each belongs to the stamp
   * it was built for, so it goes whenever that stamp leaves the grant or the fields
   * naming it change — the batch's signer key, its lifetime (a renewal keeps
   * the batch and the key), or the account inputs baked into its stamper (a
   * local account migrating to a synced one keeps the stamp) — before
   * anything is built for the next one. Otherwise a coordinator outlives its
   * stamp: after the drive is removed, or the connection moves to another
   * account, an upload still takes that coordinator's lease and spends the old
   * batch while the dApp is told there is no stamp at all. Tearing it down
   * aborts an upload in flight on it.
   *
   * Then the primary is built if it has no write path yet; any other granted
   * drive waits for its first write (`writePathFor`).
   */
  async reconcile(): Promise<void> {
    const { primary, granted } = this.host.lookupDrivesForApp()
    if (this.drives.size > 0) {
      const account =
        granted.length > 0 ? await this.host.lookupAccountForApp() : undefined
      const fingerprint = account
        ? `${account.owner.toHex()}-${uint8ArrayToHex(account.encryptionKey)}`
        : undefined
      for (const drive of [...this.drives.values()]) {
        const stamp = granted.find(
          (candidate) => candidate.batchID.toHex() === drive.batchId,
        )
        const unchanged =
          stamp !== undefined &&
          stamp.signerKey.toHex() === drive.signerKey &&
          fingerprint === drive.accountFingerprint &&
          sameStampLifetime(stamp, drive.lifetime)
        if (!unchanged) this.teardown(drive)
      }
    }
    this.primaryBatchId = primary?.batchID.toHex()
    if (primary && !this.drives.has(primary.batchID.toHex())) {
      await this.add(primary).ready
    }
  }

  /** Register a write path for `stamp` and start building it. */
  add(stamp: PostageStamp): DriveWritePath {
    const drive = new DriveWritePath(
      stamp.batchID.toHex(),
      stamp.signerKey.toHex(),
      stamp,
    )
    this.drives.set(drive.batchId, drive)
    drive.ready = this.build(drive, stamp.depth, isScratchDrive(stamp))
    return drive
  }

  /**
   * The write path for `batchId`, built on the first write to it (#862).
   * Refuses a drive the app was not granted.
   */
  async writePathFor(batchId: string): Promise<DriveWritePath> {
    let drive = this.drives.get(batchId)
    if (!drive) {
      const stamp = this.host
        .lookupDrivesForApp()
        .granted.find((candidate) => candidate.batchID.toHex() === batchId)
      if (!stamp) {
        throw new SwarmIdError(
          "drive-not-granted",
          "This app has not been granted that drive in Swarm ID.",
        )
      }
      drive = this.add(stamp)
    }
    await drive.ready
    // A reconcile may have replaced or dropped the entry while it built; ask
    // again, which waits for its replacement or refuses a drive now gone.
    // ponytail: unbounded only if every build is superseded by the next.
    if (this.drives.get(batchId) !== drive) return this.writePathFor(batchId)
    return drive
  }

  /** Tear one drive's write path down and forget it. */
  teardown(drive: DriveWritePath): void {
    this.host.onTeardown(drive.batchId)
    drive.teardown()
    this.drives.delete(drive.batchId)
  }

  /**
   * Tear every write path down, announcing each partition held so waiting
   * peers wake now instead of sleeping out their poll interval
   * (docs/Account-Bus.md, bus-accelerated leases). The announcement races the
   * Swarm release it describes, which is harmless: the lock SOCs stay the
   * authority, so a peer woken too early just spends one extra read round.
   */
  teardownAll(): void {
    for (const drive of [...this.drives.values()]) this.teardown(drive)
    this.primaryBatchId = undefined
  }

  /** Tear everything down and build the write paths afresh. */
  async rebuild(): Promise<void> {
    this.teardownAll()
    await this.reconcile()
  }

  /**
   * Build the drive's stamper and the coordinator that writes through it.
   * Logs and returns rather than throwing when either cannot be built, so a
   * resolved stamp with no stamper is a state the session really reaches.
   */
  private async build(
    drive: DriveWritePath,
    stampDepth: number,
    scratch: boolean,
  ): Promise<void> {
    const { signerKey, batchId } = drive
    // `loadAuthData` calls this off the reconcile queue, so a storage event's
    // `refreshStampFromStorage` can clear or rebind the stamp under any await
    // below (#804). Every rebind is a new `DriveWritePath`, a re-resolve of the
    // SAME stamp included — a storage event during the first init finds no
    // fingerprint yet and resolves again — so an init whose drive is no longer
    // the session's has been superseded, and leaves the session to the init
    // that superseded it.
    const superseded = (): boolean => this.drives.get(batchId) !== drive

    // Look up account info for utilization tracking
    const accountInfo = await this.host.lookupAccountForApp()
    if (superseded()) return
    if (!accountInfo) {
      console.warn("[Proxy] Cannot initialize stamper: account not found")
      return
    }

    // Initialize utilization cache if not already done
    if (!this.utilizationStore) {
      this.utilizationStore = new UtilizationStoreDB()
    }

    // Create utilization-aware stamper with owner and encryption key
    let stamper: UtilizationAwareStamper
    try {
      stamper = await UtilizationAwareStamper.create(
        signerKey,
        new BatchId(batchId),
        stampDepth,
        this.utilizationStore,
        accountInfo.owner,
        accountInfo.encryptionKey,
        undefined,
        { scratch },
      )
    } catch (error) {
      // Nothing to clear: the write path was dropped when the stamp was
      // resolved (`reconcile`), and if this init has been superseded,
      // whatever stamper there is by now belongs to the newer one.
      console.error("[Proxy] Failed to create stamper:", error)
      return
    }
    if (superseded()) return

    // No await from here to `startLease`: the stamper is attached the moment
    // `create` returns, because a utilization delta that arrives while there
    // is no stamper is dropped, so one a peer broadcast after `create` read
    // the stored counters would end up in neither.
    const coordinator = this.host.createCoordinator(drive, stamper, accountInfo)
    drive.attach(
      stamper,
      `${accountInfo.owner.toHex()}-${uint8ArrayToHex(accountInfo.encryptionKey)}`,
      coordinator,
    )
    coordinator.startLease()
  }
}
