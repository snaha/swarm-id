// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Chunk size constants. An empty payload is valid — Bee represents
// zero-length content as a single chunk with span 0 (cac.validateDataLength
// allows 0..4096).
export const MIN_PAYLOAD_SIZE = 0
export const MAX_PAYLOAD_SIZE = 4096

// Span size (8 bytes for uint64 little-endian)
export const SPAN_SIZE = 8

// Reference sizes
export const UNENCRYPTED_REF_SIZE = 32
export const ENCRYPTED_REF_SIZE = 64

// SOC (Single Owner Chunk) constants
export const IDENTIFIER_SIZE = 32
export const SIGNATURE_SIZE = 65
export const SOC_HEADER_SIZE = IDENTIFIER_SIZE + SIGNATURE_SIZE

// Download concurrency
export const DEFAULT_DOWNLOAD_CONCURRENCY = 64

// Upload concurrency (lower than download due to more server-side overhead)
export const DEFAULT_UPLOAD_CONCURRENCY = 8
