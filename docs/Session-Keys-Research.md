# Session Keys Research Report: Technical Approaches for SwarmID

## Executive Summary

This report analyzes technical approaches for implementing **Session Keys** in SwarmID - temporary cryptographic keys that are time-bound, revokable, and act as proxies for a Persona's authority. The challenge is significant because Swarm's content-addressed storage is inherently **immutable**, making time-based access and revocation non-trivial.

---

## 1. Requirements Analysis

From the requirements document, Session Keys must support:

| Requirement             | Description                                       | Difficulty |
| ----------------------- | ------------------------------------------------- | ---------- |
| **Time-Bound Validity** | Valid only within `[Start_Time, End_Time]`        | Medium     |
| **Automatic Expiry**    | Invalid after End_Time                            | Medium     |
| **Explicit Revocation** | Revokable before expiry                           | High       |
| **ACT Compatibility**   | Decrypt content on behalf of Persona              | High       |
| **State Permanence**    | Actions persist after session ends                | Low        |
| **Verification**        | Any client can verify Session Key → Persona chain | Medium     |

---

## 2. Technical Approaches

### Approach A: Signed Authorization Certificate (Recommended)

**Concept**: The Persona signs a "delegation certificate" containing the Session Key's public key, validity window, and permissions.

```
Authorization Certificate = {
    sessionPublicKey: bytes32,
    personaPublicKey: bytes32,
    validFrom: timestamp,
    validUntil: timestamp,
    permissions: string[],  // optional: "read", "write", "grant"
    nonce: bytes32
}
signature = sign(keccak256(certificate), personaPrivateKey)
```

**Implementation**:

1. **Creation**: Persona signs certificate, stores on Swarm (SOC or manifest)
2. **Verification**: Any verifier checks:
   - Signature matches Persona's public key
   - Current time is within `[validFrom, validUntil]`
   - Permissions include required action
3. **Revocation**: Persona publishes revocation entry to a feed

**Revocation Feed Structure**:

```
topic = keccak256("revocation-list-" + personaAddress)
payload = [sessionKeyHash1, sessionKeyHash2, ...]
```

**Pros**:

- Simple to implement with existing Swarm primitives
- Certificate can be stored once and referenced
- Verification is O(1) for time check, O(n) for revocation list
- Works with existing ACT infrastructure

**Cons**:

- Revocation requires polling the revocation feed
- Time-based expiry is client-enforced, not cryptographic

**Use Case Fit**: All four use cases from requirements document

---

### Approach B: ACT with Session Key as Grantee

**Concept**: Add the Session Key's public key directly to the ACT's grantee list with metadata indicating validity period.

**Current ACT Structure** (from `lib/src/proxy/act/index.ts`):

```typescript
// Each grantee gets: lookupKey → encryptedAccessKey
entries: Map<lookupKey, encryptedAccessKey>
```

**Extended Structure**:

```typescript
entries: Map<
  lookupKey,
  {
    encryptedAccessKey: bytes
    validFrom?: timestamp
    validUntil?: timestamp
    isSessionKey?: boolean
  }
>
```

**Verification Logic**:

```typescript
function canAccess(lookupKey: bytes, currentTime: number): boolean {
  const entry = act.get(lookupKey)
  if (!entry) return false
  if (entry.validFrom && currentTime < entry.validFrom) return false
  if (entry.validUntil && currentTime > entry.validUntil) return false
  return true
}
```

**Pros**:

- Integrated with existing ACT mechanism
- Per-grantee expiration metadata

**Cons**:

- Requires ACT format extension (breaks Bee compatibility)
- Time enforcement is still client-side
- Revocation requires full ACT key rotation (expensive)
- No true cryptographic time-locking

**Use Case Fit**: Use Cases 1, 3 (read/grant) | Use Cases 2, 4 (write requires different approach)

---

### Approach C: Epoch-Based Session Feeds

**Concept**: Leverage SwarmID's existing epoch-based feed system to publish session validity states.

From `lib/src/proxy/feeds/epochs/`, the system already supports:

- Time-indexed updates via binary tree epochs
- Efficient lookup at arbitrary timestamps
- Monotonic updates

**Session State Feed**:

```typescript
topic = keccak256("sessions-" + personaAddress)

// Each update contains:
payload = {
    activeSessionKeys: Map<sessionKeyHash, {
        publicKey: bytes,
        validUntil: timestamp,
        permissions: string[]
    }>,
    revokedSessionKeys: sessionKeyHash[]
}
```

**Verification Flow**:

1. Look up latest feed entry at current timestamp
2. Check if sessionKeyHash exists and isn't revoked
3. Verify time bounds

**Pros**:

- Uses proven feed infrastructure
- Natural time-based indexing
- Efficient updates via epochs
- Immediate revocation visibility

**Cons**:

- Requires network lookup for every verification
- Session state is mutable (not immutable proof)
- Complexity in multi-device scenarios

**Use Case Fit**: All four use cases, especially Use Case 4 (collaborative editing with revocation)

---

### Approach D: Proxy Re-Encryption (PRE)

**Concept**: Use cryptographic proxy re-encryption to delegate decryption rights with time attributes.

Based on academic research:

```
1. Content encrypted with content key K
2. K encrypted with Persona's public key → CK_persona
3. Persona generates re-encryption key: reKey = f(personaPriv, sessionPub, validUntil)
4. Proxy transforms: CK_persona → CK_session (valid only until validUntil)
5. Session key can decrypt K, then decrypt content
```

**The Challenge**: Standard PRE doesn't enforce time - it's a trust assumption on the proxy.

**Blockchain-Enhanced PRE**:

- Smart contract holds re-encryption keys
- Time-release via smart contract conditions
- Revocation by removing re-encryption key from contract

**Pros**:

- Cryptographically enforced delegation
- Clean separation of duties
- Can integrate with blockchain for time enforcement

**Cons**:

- Complex implementation
- Requires additional infrastructure (proxy service or smart contract)
- Not native to Swarm's current architecture
- Performance overhead

**Use Case Fit**: Theoretical fit but high implementation complexity

---

### Approach E: Derived Session Keys with Time Epochs

**Concept**: Deterministically derive session keys from master key + time epoch, so only the current epoch's keys are valid.

```
epochKey = HKDF(masterKey, "session" || floor(timestamp / epochDuration))
sessionKey = derive(epochKey, sessionNonce)
```

**How it works**:

1. Both Persona and verifier can compute current epoch's valid keys
2. Old epoch keys automatically become invalid (not derivable from current state)
3. No explicit revocation needed - just stop including key in derivation

**Pros**:

- Automatic expiry without revocation mechanism
- Deterministic - anyone can verify
- No storage of session state needed

**Cons**:

- Fixed epoch boundaries (can't expire at arbitrary times)
- No fine-grained revocation within an epoch
- Requires shared secret (epoch key) distribution

**Use Case Fit**: Works for fixed-duration sessions, not arbitrary time windows

---

### Approach F: Time-Lock Encryption

**Concept**: Encrypt session authorization in a time-locked puzzle that becomes solvable only at start time.

Based on Rivest-Shamir-Wagner time-lock puzzles:

```
puzzle = encrypt(sessionAuth, puzzleKey)
// puzzleKey requires T sequential computations to derive
// Anyone can start computing, but takes fixed wall-clock time
```

**Modern approaches** use blockchain-based time-release:

- Future block hash as decryption key
- Smart contract releases key at specified block height

**Pros**:

- Cryptographically enforced "not before" time
- Decentralized time oracle (blockchain)

**Cons**:

- Only handles start time, not end time
- Doesn't solve revocation
- Requires blockchain integration

**Use Case Fit**: Incomplete solution (only handles delayed start)

---

## 3. Proposed Architecture: Hybrid Approach

Based on the analysis, we recommend a **hybrid approach** combining:

1. **Signed Authorization Certificates** (Approach A) for delegation proof
2. **Epoch-Based Session Feeds** (Approach C) for revocation
3. **Modified ACT Integration** for content access

### Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│                        PERSONA WALLET                         │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ Master Key  │─▶│ Sign Certificate │─▶│ Publish to Feed  │  │
│  └─────────────┘  └──────────────────┘  └──────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────┐
│                   AUTHORIZATION CERTIFICATE                   │
│                                                               │
│  {                                                            │
│    sessionPublicKey: "0x...",                                 │
│    persona: "0x...",                                          │
│    validFrom: 1739800000,                                     │
│    validUntil: 1739807200,  // +2 hours                       │
│    permissions: ["act:decrypt", "feed:write"],                │
│    signature: "0x..."                                         │
│  }                                                            │
│                                                               │
│  Stored at: SOC(persona, "auth-cert-" + hash(sessionPub))     │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────┐
│                      SESSION STATE FEED                       │
│                                                               │
│  Topic: keccak256("sessions-" + personaAddress)               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Epoch Update:                                           │  │
│  │   activeSessions: [sessionKeyHash1, sessionKeyHash2]    │  │
│  │   revokedSessions: [sessionKeyHash3]                    │  │
│  │   timestamp: 1739800500                                 │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────┐
│                       VERIFICATION FLOW                       │
│                                                               │
│  1. App presents: sessionPrivateKey + authCertificate         │
│  2. Verifier checks:                                          │
│     a. Certificate signature valid (persona signed it)        │
│     b. currentTime ∈ [validFrom, validUntil]                  │
│     c. sessionKeyHash not in revokedSessions (feed lookup)    │
│  3. If valid: Session key can perform permitted operations    │
└───────────────────────────────────────────────────────────────┘
```

### ACT Integration

For ACT decryption with session keys:

**Option 1: Persona pre-authorizes session key in ACT**

```typescript
// Persona adds session key as temporary grantee
await addGranteeToAct(actReference, sessionPublicKey, {
  validUntil: certificate.validUntil,
  delegatedFrom: personaPublicKey,
})
```

**Option 2: Session key derives access via certificate chain**

```typescript
// Session key doesn't need to be in ACT directly
// Verification: Session → Certificate → Persona → ACT
if (certificate.permissions.includes('act:decrypt')) {
  // Use ECDH: sessionPriv × actPublisher to derive access
  // But only if persona is in ACT grantee list
}
```

The second option is more elegant but requires client-side enforcement.

---

## 4. Implementation Considerations

### 4.1 Storage Locations

| Data                      | Storage                  | Reason                                   |
| ------------------------- | ------------------------ | ---------------------------------------- |
| Authorization Certificate | SOC (Single Owner Chunk) | Immutable proof, content-addressed       |
| Session State Feed        | Epoch-based Feed         | Mutable, time-indexed, efficient updates |
| Revocation List           | Same feed or separate    | Fast lookup for revocation checks        |
| Certificate Index         | Manifest/Mantaray        | Discovery of all issued certificates     |

### 4.2 Verification Performance

```
Verification Cost:
- Certificate signature check: O(1) - local crypto
- Time bounds check: O(1) - local comparison
- Revocation check: O(1) to O(n) - depends on implementation
  - Feed lookup: ~100-500ms network latency
  - Cached revocation list: O(1) local lookup
```

**Recommendation**: Cache revocation list with configurable refresh interval.

### 4.3 Multi-Device Scenarios

For Use Case 4 (collaborative editing), multiple devices need coordinated view of session state:

```
Device A (Alice's laptop): Creates session, publishes cert
Device B (Alice's phone): Can revoke session, publishes to feed
Device C (Bob's browser): Verifies Alice's session via feed lookup
```

**Challenge**: Feed updates have propagation delay. Solutions:

1. Push notifications via PSS (Postal Service over Swarm)
2. Polling with exponential backoff
3. Websocket connection to gateway for real-time updates

### 4.4 Security Considerations

| Threat                              | Mitigation                                                             |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Certificate replay after revocation | Always check revocation feed                                           |
| Session key extraction from browser | Short validity windows, immediate revocation capability                |
| Clock skew between parties          | Use blockchain block number as authoritative time, or tolerance window |
| Fake revocation (DoS)               | Only persona can sign revocation (signature required)                  |

---

## 5. Comparison with Requirements

| Requirement         | Proposed Solution                                     | Enforcement Level       |
| ------------------- | ----------------------------------------------------- | ----------------------- |
| Time-Bound Validity | Certificate timestamps                                | Client-enforced         |
| Automatic Expiry    | validUntil check                                      | Client-enforced         |
| Explicit Revocation | Revocation feed                                       | Network-verified        |
| ACT Compatibility   | Session key as delegated grantee or certificate chain | Protocol extension      |
| State Permanence    | Actions use persona's authority at execution time     | Inherent                |
| Verification        | Certificate signature + feed check                    | Cryptographic + network |

**Key Insight**: True cryptographic time-enforcement would require:

- Blockchain smart contracts (adds dependency)
- Time-lock puzzles (only handles start time)
- Trusted time server (centralization)

The proposed solution accepts **client-enforced time bounds** with **cryptographic revocation verification** as a practical tradeoff.

---

## 6. Alternative: Blockchain-Backed Session Keys

For stronger guarantees, integrate with smart contracts:

```solidity
contract SessionKeyRegistry {
    mapping(bytes32 => Session) public sessions;

    struct Session {
        address persona;
        bytes32 sessionKeyHash;
        uint256 validFrom;
        uint256 validUntil;
        bool revoked;
    }

    function registerSession(bytes32 keyHash, uint256 duration) external {
        sessions[keyHash] = Session(
            msg.sender,
            keyHash,
            block.timestamp,
            block.timestamp + duration,
            false
        );
    }

    function revoke(bytes32 keyHash) external {
        require(sessions[keyHash].persona == msg.sender);
        sessions[keyHash].revoked = true;
    }

    function isValid(bytes32 keyHash) external view returns (bool) {
        Session memory s = sessions[keyHash];
        return !s.revoked &&
               block.timestamp >= s.validFrom &&
               block.timestamp <= s.validUntil;
    }
}
```

**Pros**: Authoritative time source, atomic revocation
**Cons**: Gas costs, blockchain dependency, latency

---

## 7. Recommendations

### Short-Term (PoC)

1. Implement **Signed Authorization Certificates** stored as SOCs
2. Add **time bounds checking** to verification flow
3. Implement **revocation feed** using existing epoch-based feeds
4. Client-side enforcement is acceptable for PoC

### Medium-Term (Production)

1. Extend ACT format to support **session key metadata**
2. Add **PSS-based push notifications** for revocation
3. Consider **caching layer** for revocation lists
4. Document security model clearly

### Long-Term (Future Research)

1. Evaluate **Proxy Re-Encryption** for stronger cryptographic guarantees
2. Investigate **blockchain integration** for authoritative time
3. Research **Attribute-Based Encryption** for granular permissions

---

## 8. Relevant Codebase Files

The following existing files in SwarmID are relevant to session key implementation:

| File                                     | Relevance                                          |
| ---------------------------------------- | -------------------------------------------------- |
| `lib/src/proxy/act/index.ts`             | ACT implementation, grantee management, revocation |
| `lib/src/proxy/act/history.ts`           | Time-based history with reversed timestamps        |
| `lib/src/proxy/act/crypto.ts`            | ECDH key derivation, CTR encryption                |
| `lib/src/proxy/feeds/epochs/`            | Epoch-based feed system for time-indexed updates   |
| `lib/src/proxy/upload-encrypted-data.ts` | SOC creation and signing                           |
| `lib/src/proxy/download-data.ts`         | SOC verification and decryption                    |
| `lib/src/utils/ttl.ts`                   | TTL calculation utilities                          |

---

## Sources

- [Proxy Re-Encryption for Decentralized Storage Networks](https://www.mdpi.com/2076-3417/12/9/4260)
- [Time-lock puzzles and timed-release Crypto (Rivest, Shamir, Wagner)](https://people.csail.mit.edu/rivest/pubs/RSW96.pdf)
- [Blockchain-based Decentralized Time Lock Machines](https://arxiv.org/html/2401.05947v1)
- [Survey on Revocation in Ciphertext-Policy Attribute-Based Encryption](https://www.mdpi.com/1424-8220/19/7/1695)
- [Time-Based Direct Revocable CP-ABE](https://eprint.iacr.org/2018/330.pdf)
- [Blockchain-enabled supervised secure data sharing](https://journalofcloudcomputing.springeropen.com/articles/10.1186/s13677-023-00575-8)
- [Time-lock encryption overview (Gwern)](https://gwern.net/self-decrypting)
- [The Book of Swarm](../The-Book-of-Swarm.txt) - Swarm protocol documentation
