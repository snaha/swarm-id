# WebAuthn PRF-Based Deterministic Ethereum Address Derivation

## Overview

This implementation uses the **WebAuthn PRF (Pseudo-Random Function) extension** to derive a deterministic Ethereum address from a passkey, **without storing any keys or secrets**. Every time you authenticate with the same passkey, you get the same Ethereum address.

## How It Works

### 1. **Passkey Registration** (First Time Setup)

When you create a passkey:

- Your device (iPhone, Mac, Android, etc.) generates a **private key** in the **Secure Enclave** (hardware security chip)
- This private key **never leaves the device** and cannot be extracted
- We request the **PRF extension** to be enabled for this credential
- The public key and credential ID are stored (but not the private key)

```javascript
// During registration, we enable PRF:
extensions: {
	prf: {
	}
}
```

### 2. **Passkey Authentication** (Signing In)

When you authenticate:

- We provide a **deterministic salt** to the PRF extension
- The salt is: `SHA256("yourdomain.com:ethereum-identity-v1")`
- This salt is always the same for your domain

```javascript
// During authentication, we evaluate PRF with our salt:
extensions: {
	prf: {
		eval: {
			first: salt // ArrayBuffer of our deterministic salt
		}
	}
}
```

### 3. **PRF Extension Magic** 🔮

The PRF extension performs a **hardware-backed cryptographic operation**:

```
PRF Output = HMAC-SHA256(secret_in_secure_enclave, our_salt)
```

**Key properties:**

- The **secret never leaves the Secure Enclave**
- Same passkey + same salt = **always the same output** (deterministic)
- Different salt = completely different output
- 32 bytes of cryptographically secure random-looking data
- **Domain-isolated** by the browser (can't be used cross-origin)

### 4. **Key Derivation** (Turning PRF Output into an Ethereum Address)

We take the PRF output and derive an Ethereum address using proper cryptographic practices:

```
Step 1: PRF Output (32 bytes from Secure Enclave)
        ↓
Step 2: HKDF (HMAC-based Key Derivation Function)
        - Input: PRF output
        - Info: "ethereum-wallet-seed"
        - Output: 32 bytes of entropy
        ↓
Step 3: HD Wallet (Hierarchical Deterministic Wallet)
        - Create wallet from entropy seed
        - Uses BIP-32 derivation
        ↓
Step 4: Ethereum Address (e.g., 0x1234...5678)
```

### Why HKDF?

HKDF is an industry-standard key derivation function (NIST SP 800-56C) that:

- Extracts uniform randomness from the PRF output
- Expands it with domain-specific context ("ethereum-wallet-seed")
- Provides cryptographic separation between different use cases

## Security Properties

### ✅ **Hardware-Backed**

- The master secret is in the Secure Enclave (hardware chip)
- Even malware on your device cannot extract it
- Protected by biometrics (Face ID, Touch ID, Windows Hello)

### ✅ **Deterministic**

- Same passkey → same Ethereum address (reproducible)
- No storage needed - derive on-demand every time
- Works across device resets (as long as passkey syncs)

### ✅ **Domain-Isolated**

- Browser adds domain context automatically
- `example.com` cannot derive keys for `other.com`
- Prevents cross-site tracking

### ✅ **No Private Key Export**

- The Secure Enclave secret never leaves the hardware
- Even you cannot export it
- Cannot be phished or stolen by malware

## Browser Support

| Browser/Platform             | Support                         |
| ---------------------------- | ------------------------------- |
| Chrome 128+ (Desktop)        | ✅ Full support                 |
| Safari 18+ (iOS 18/macOS 15) | ✅ Platform authenticators only |
| Edge 128+                    | ✅ Full support                 |
| Firefox                      | ⚠️ Limited (security keys only) |
| Android Chrome               | ✅ Good support                 |

**Note:** PRF support is relatively new (late 2024). Older browsers/OS versions will not work.

## Comparison with Traditional Approaches

### Traditional: Encrypted Storage

```
User Password → Encryption Key → Decrypt Keystore → Private Key
```

**Issues:**

- ❌ Requires password management
- ❌ Keystore file can be lost
- ❌ Vulnerable to weak passwords

### Our Approach: PRF-Based Derivation

```
Passkey Biometric → PRF → Derive Address
```

**Advantages:**

- ✅ No passwords needed
- ✅ No storage required
- ✅ Hardware-backed security
- ✅ Biometric convenience

## What Happens Step-by-Step

### When You Click "Use Passkey":

1. **Browser prompts for biometric** (Face ID, fingerprint, etc.)

2. **Passkey authenticates** with hardware security

3. **PRF evaluation happens in Secure Enclave:**

   ```
   PRF(secret, "id.ethswarm.org:ethereum-identity-v1")
   → a1b2c3d4e5f6...  (32 bytes)
   ```

4. **HKDF derives wallet seed:**

   ```
   HKDF(prf_output, "ethereum-wallet-seed")
   → 7f8e9d0c1b2a...  (32 bytes)
   ```

5. **HD Wallet creates Ethereum address:**

   ```
   HDNodeWallet.fromSeed(entropy)
   → 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
   ```

6. **Same passkey = same address every time!** ✅

## Why This Matters for Swarm Identity

For Swarm's decentralized identity system, this enables:

- **Passwordless accounts** - Just use Face ID/Touch ID
- **No key management burden** - Hardware handles it
- **Cross-device with passkey sync** - iCloud Keychain, Google Password Manager
- **Deterministic identity** - Same passkey = same identity
- **App-specific keys** - Different salts for different apps
- **Future hierarchical keys** - Can derive multiple keys from same PRF

## Technical Terms Explained

- **PRF (Pseudo-Random Function)**: A cryptographic function that produces random-looking output from secret input
- **Secure Enclave**: Hardware security chip in modern devices (like Apple T2, TPM, etc.)
- **HKDF**: Industry-standard way to derive cryptographic keys from other key material
- **HD Wallet**: Bitcoin/Ethereum standard for generating multiple addresses from one seed
- **Deterministic**: Always produces the same output for the same input (reproducible)
- **ArrayBuffer**: JavaScript's way of representing raw binary data

## Frequently Asked Questions

### Is it safe if my domain/salt is public and not secret?

**Yes, it's completely safe.** The security comes from the **secret key in your Secure Enclave**, not from the salt being secret.

The PRF operation is:

```
PRF Output = HMAC-SHA256(secret_in_secure_enclave, public_salt)
```

HMAC is designed to be secure even when the message (salt) is known to attackers. An attacker who knows:

- ✅ Your domain and salt
- ✅ Your Ethereum address

**Still cannot:**

- ❌ Extract the Secure Enclave secret
- ❌ Generate your PRF output
- ❌ Derive your private key

The salt's purpose is **domain separation** (different outputs for different purposes) and **determinism** (same salt = same output), not security. This is the same security model used by production systems like Bitwarden (password manager), Signal (E2EE messaging), and Bitcoin HD wallets.

Additionally, the browser automatically adds domain isolation, so even if another website uses your exact salt, they get completely different outputs because:

1. Different Secure Enclave secret
2. Browser enforces RP ID separation
3. Different passkey entirely

## Limitations

⚠️ **If you delete your passkey, you lose access to your Ethereum address forever**

- There's no "password reset"
- The passkey IS your identity
- Recommendation: Use passkey sync (iCloud Keychain, Google) for backup

⚠️ **Browser support is limited**

- Requires very recent browsers (Chrome 128+, Safari 18+, iOS 18+)
- Not available on older devices

⚠️ **Different devices may give different addresses**

- If passkeys don't sync between devices, each device creates its own passkey
- Solution: Use platforms with passkey sync enabled

## Bottom Line

**We're using your device's hardware security chip to deterministically derive an Ethereum address from your biometric authentication, without ever storing or exposing any private keys.**

It's like having a hardware wallet built into your device, but even more secure because the master secret never leaves the Secure Enclave, not even during derivation.

## Implementation Details

### Code Location

- Main implementation: `src/lib/passkey.ts`
- Usage example: `src/routes/+page.svelte`

### Key Functions

- `generatePRFSalt()`: Creates deterministic salt from domain
- `deriveKeyWithHKDF()`: Applies HKDF to PRF output
- `deriveEthereumAddress()`: Creates Ethereum address from entropy
- `authenticateWithPasskey()`: Main authentication flow with PRF

### Dependencies

- `@simplewebauthn/browser`: WebAuthn wrapper library
- `ethers`: Ethereum wallet and HD derivation

## References

- [WebAuthn PRF Extension Spec](https://w3c.github.io/webauthn/#prf-extension)
- [SimpleWebAuthn PRF Documentation](https://simplewebauthn.dev/docs/advanced/prf)
- [HKDF RFC 5869](https://tools.ietf.org/html/rfc5869)
- [BIP-32: Hierarchical Deterministic Wallets](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)
- [Yubico PRF Developer Guide](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/)
