# Account Architecture: Open Issues for Discussion

Two independent proposals — [#308](https://github.com/snaha/swarm-id/issues/308) and [#313](https://github.com/snaha/swarm-id/issues/313) — affect how accounts and identities are structured. Both are breaking changes and require migration strategies before they can ship. They are independent but interact: adopting [#308](https://github.com/snaha/swarm-id/issues/308) reduces the motivation for the account-level grouping, making [#313](https://github.com/snaha/swarm-id/issues/313) more attractive as a follow-on.

---

# Use Mnemonics for All Account Types ([#308](https://github.com/snaha/swarm-id/issues/308))

## Background

The three account types currently derive and protect their master key in incompatible ways:

- **Ethereum account**: A custom "secret seed" (not BIP-39) is the root of the master key. The seed is encrypted using the _public key_ of the user's Ethereum wallet, so the user can decrypt it by signing a message. This means the wallet must not be used for on-chain transactions to avoid key reuse ([#85](https://github.com/snaha/swarm-id/issues/85)). The secret seed is a SwarmID-only concept with no industry precedent.
- **Passkey account**: The master key is derived from the output of the WebAuthn PRF extension. No mnemonic is involved. If the passkey is deleted, the account cannot be recovered ([#191](https://github.com/snaha/swarm-id/issues/191)).
- **Agent account**: Already uses a standard BIP-39 mnemonic (12–24 words). The mnemonic is not stored — it must be re-entered on each authentication. This is functional for bots but impractical for humans.

## Proposal

Standardise on BIP-39 mnemonics as the root secret across all account types:

- **Ethereum**: The mnemonic is the root. The ETH wallet signs a deterministic EIP-712 message (confirmed non-random for MetaMask and Coinbase Wallet — [#200](https://github.com/snaha/swarm-id/issues/200)), producing entropy that encrypts the mnemonic at rest. The wallet is only used for encryption, not on-chain signing.
- **Passkey**: The mnemonic is the root. The passkey PRF output encrypts the mnemonic at rest. The passkey becomes a key-protection layer rather than the sole source of entropy.
- **Agent**: No change. The mnemonic is entered directly on each authentication.

## Advantages

1. **Portability** — A BIP-39 mnemonic can be taken to any device, entered offline, or backed up with a hardware wallet workflow.
2. **Familiarity** — The 12–24-word mnemonic is the dominant secret management pattern in Web3; users are more likely to understand and respect it.
3. **Cross-wallet compatibility** — Any standard Ethereum wallet can be used (including ENS-linked wallets), removing the current restriction that the wallet must not be used for on-chain transactions.
4. **Recovery without file backup** — The mnemonic becomes the primary out-of-band recovery path, superseding or complementing the `.swarmid` file export.
5. **Passkey as encryption layer only** — Passkey deletion no longer means account loss. The mnemonic survives and can be re-protected by a new passkey, resolving [#191](https://github.com/snaha/swarm-id/issues/191).
6. **Alignment across account types** — A single mental model applies to all types; the difference between them becomes only the encryption/protection mechanism.
7. **Enables Swarm backup for Ethereum accounts** — [#204](https://github.com/snaha/swarm-id/issues/204) proposes using an EIP-712-derived encryption key for Swarm-hosted backup. This becomes cleaner if the mnemonic is the thing being backed up.

## Disadvantages

1. **Breaking change — no silent migration** — Existing Ethereum accounts use a proprietary secret seed, not a BIP-39 mnemonic. There is no way to derive one from the other automatically. Existing users must re-create their account or go through an explicit migration with manual steps.
2. **Onboarding friction** — Presenting a mnemonic at account creation and requiring the user to write it down adds a step that slows sign-up. Passkey flows are currently frictionless.
3. **Additional credential to manage** — Users now hold: mnemonic (written down or in password manager) + wallet or passkey. For passkey-only users this doubles the secret count.
4. **Mnemonic exposure risks** — Whenever a mnemonic is displayed on screen or typed, it is susceptible to shoulder surfing, screen capture, or keylogging. The current passkey PRF flow never exposes a copyable secret.
5. **Password-protection UX** — To avoid the mnemonic being the only factor, a password or PIN to encrypt it at rest is desirable. This adds another screen and another secret to manage.
6. **Passkey flow becomes two-step** — Currently, passkey authentication is a single browser gesture. With a mnemonic encrypted by PRF, the PRF output must first decrypt the mnemonic before any key material is available, adding latency and complexity to the auth path.
7. **Agent UX unchanged** — Agents still need to enter the mnemonic on every authentication. The proposal does not materially improve the human-facing agent experience unless a password-protected keyfile is also introduced.

## Compatibility with PoC#1 Requirements

| Requirement                               | Impact                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Separate user identity from node identity | Not affected — identity key derivation hierarchy is unchanged                                                   |
| Persona separation (highly recommended)   | Not affected — personas still derived from identity keys                                                        |
| Swarm-based user metadata / master stamp  | Neutral — mnemonic-based root makes Swarm backup simpler ([#204](https://github.com/snaha/swarm-id/issues/204)) |
| JavaScript-only, no installation          | Not affected                                                                                                    |
| Future-proof interfaces                   | Improved — BIP-39 is a long-standing standard                                                                   |

---

# Consider Having Only Identity Level ([#313](https://github.com/snaha/swarm-id/issues/313))

## Background

The current data model has two tiers:

- **Account**: The authentication layer. Created once per credential (one passkey, one Ethereum wallet, or one mnemonic). Holds the master key derivation root, postage stamps, devices, and sync state.
- **Identity**: A derived key pair (account master key + identity ID → identity private/public key + address). Multiple identities can exist under one account. All identities share the same authentication credential — unlocking the account unlocks all its identities simultaneously.

In practice the vast majority of users create exactly one identity per account. The extra tier adds UI steps ("create account, then create identity"), conceptual overhead ("what is an account vs. an identity?"), and code complexity (every lookup must join account and identity by `accountId`).

## Proposal

Collapse to a single **identity** level. The credential (passkey, wallet, mnemonic) directly protects a single key pair. There is no intermediate account object:

- "Create an identity" is the only onboarding action.
- No `accountId` field on the identity; no separate account storage key.
- The developer-facing API (iframe postMessage protocol, `ConnectionInfo.identity`) is unchanged.

## Advantages

1. **UX simplicity** — One flow instead of two. "Create an identity" is a self-contained action with an immediately usable result.
2. **Clearer mental model** — Users reason about identities, not accounts. "My passkey protects my identity" is more direct than "my passkey protects my account which contains my identity."
3. **True isolation between identities** — Two identities created with different credentials are cryptographically independent. Connecting a dApp to one identity gives zero access to the other, even for the same physical user.
4. **Code simplification** — Removes `accountId` from `IdentitySchemaV1`, removes the accounts storage key, removes the account → identity join in every lookup path, and simplifies the sync snapshot format.
5. **Symmetric with [#308](https://github.com/snaha/swarm-id/issues/308)** — If mnemonics become the root secret ([#308](https://github.com/snaha/swarm-id/issues/308)), the mnemonic _is_ the identity. There is no natural "account" to group multiple identities under.

## Disadvantages

1. **Breaking change — data migration required** — All existing records carry `accountId`. The migration must either drop the field (losing grouping information) or reinterpret it. Postage stamps and sync state are keyed to accounts, not identities, and must be re-keyed.
2. **Multi-identity management is harder** — Currently a user can hold multiple identities under one passkey. With a flat model they need separate credentials for each identity. Managing more than one identity becomes significantly more friction-heavy.
3. **Persona support becomes harder to add later** — The Requirements document explicitly calls persona separation "highly recommended." A persona is a sub-identity — a level below identity. Flattening to one tier today means reintroducing a sub-level later, re-creating hierarchy in a different form.
4. **Postage stamp and sync scope** — Stamps and the Swarm sync feed are currently scoped to an account, shared across all its identities. With a flat model, each identity needs its own stamp and its own sync feed, multiplying on-Swarm storage costs and complicating multi-device sync for power users.
5. **Cross-identity content sharing** — Sharing ACT-encrypted content between two identities of the same user (e.g., publishing from identity A and reading from identity B) is currently straightforward because both identities are under the same account master key. In a flat model the two identities are fully independent.
6. **Authorization granularity is reduced** — Some use cases may want multiple identities (personas) that share a postage stamp budget or a connected app list. The flat model removes that possibility at the data layer.

## Compatibility with PoC#1 Requirements

| Requirement                               | Impact                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Separate user identity from node identity | Satisfied — the identity key pair IS the user identity                                        |
| Persona separation (highly recommended)   | **Tension** — personas need a sub-level below identity, which reintroduces hierarchy          |
| Swarm-based user metadata / master stamp  | Each identity needs its own master stamp — increases Swarm footprint for multi-identity users |
| External stamp management                 | Still feasible, but per-identity rather than per-account                                      |
| JavaScript-only, no installation          | Not affected                                                                                  |
