// Re-export public API for chunk functionality

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
