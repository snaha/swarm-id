# Master key generation

- Passkey
- SIWE

# Bee-js (to check on monday if this could/should be part of it)

- Chunking
  - Splitter - POC done with streaming encryption with Bee implementation as a reference
  - Joiner - not existing in JS yet
- Streaming
- Encription/decription
- ACT (may come later)
- Postage stamps
  - Postage stamp signing with a custom postage stamp
  - Checking utilization of a stamp (here we may want to simplify by expecting that postage stamps are not shared across identities)
  - Most bee-js methods expect postage stamp, this complicates things a bit

# IFrame communications

- Performance
- Security issues

# Idenbee-js

- Proxy to the bee-js, it translates all the calls via the iframe (excluding the postage stamps)
- Expose functionality like connect wallet

# Keystore library

- Abstracts the interface to the keystore file
- It knows the derivation path and based on that gives you the right item

# UI

- Most of the stuff can be done in the UI of the app except for initial identity setting up/choosing
