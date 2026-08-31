// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseAbi } from "viem"

/**
 * PostageStamp contract (verified source at the mainnet deployment,
 * byte-identical to ethersphere/storage-incentives master). Selectors are
 * pinned by unit test against independently verified constants — see
 * abi.test.ts — so a signature typo here cannot reach a wallet.
 *
 * `batches()` field order mirrors the contract's Batch struct and the
 * existing decoder in lib/src/utils/postage-contract.ts.
 */
export const POSTAGE_STAMP_ABI = parseAbi([
  "function createBatch(address _owner, uint256 _initialBalancePerChunk, uint8 _depth, uint8 _bucketDepth, bytes32 _nonce, bool _immutable) returns (bytes32)",
  "function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk)",
  "function increaseDepth(bytes32 _batchId, uint8 _newDepth)",
  "function batches(bytes32) view returns (address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag, uint256 normalisedBalance, uint256 lastUpdatedBlockNumber)",
  "function remainingBalance(bytes32 _batchId) view returns (uint256)",
  "function minimumInitialBalancePerChunk() view returns (uint256)",
  "function lastPrice() view returns (uint64)",
  "function currentTotalOutPayment() view returns (uint256)",
  "function paused() view returns (bool)",
])

/**
 * The EIP-7702 delegate's batch entry point. `Call` mirrors
 * `BaseAccount.Call{address target; uint256 value; bytes data;}` on the
 * verified deployment; the selector is pinned in abi.test.ts.
 */
export const ACCOUNT_7702_ABI = parseAbi([
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
])

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
])
