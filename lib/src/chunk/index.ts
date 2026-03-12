// Re-export public API for chunk functionality

// Constants
export {
  MIN_PAYLOAD_SIZE,
  MAX_PAYLOAD_SIZE,
  SPAN_SIZE,
  UNENCRYPTED_REF_SIZE,
  ENCRYPTED_REF_SIZE,
  IDENTIFIER_SIZE,
  SIGNATURE_SIZE,
  SOC_HEADER_SIZE,
  DEFAULT_DOWNLOAD_CONCURRENCY,
} from "./constants"

// Encryption utilities
export {
  type Key,
  type ChunkEncrypter,
  type Encrypter,
  type Decrypter,
  type EncryptionInterface,
  KEY_LENGTH,
  REFERENCE_SIZE,
  newChunkEncrypter,
  decryptChunkData,
  generateRandomKey,
  newSpanEncryption,
  newDataEncryption,
  Encryption,
  DefaultChunkEncrypter,
} from "./encryption"

// BMT hash calculation
export { calculateChunkAddress } from "./bmt"

// Content-addressed chunks
export { type ContentAddressedChunk, makeContentAddressedChunk } from "./cac"

// Encrypted content-addressed chunks
export {
  type EncryptedChunk,
  makeEncryptedContentAddressedChunk,
  decryptEncryptedChunk,
  extractEncryptionKey,
  extractChunkAddress,
} from "./encrypted-cac"
