# Swarm Identity Management PoC proposal

The problem statement and a proposed solution is outlined in the document [Identity Management Research - Project Canvas](https://docs.google.com/document/d/1ioF4lzbWHbOkRvZq4Snf1KO5GK46bvvptbqmSPlJ78w/edit?tab=t.0). In accordance with it this document describes a proof-of-concept solution where the outcome is not only a research document but instead working apps with user facing interfaces. The assumption for the user’s level of knowledge is that they used a key-based authentication flow before (e.g. Ethereum wallet or Passkey) and shared documents with some level of access control (e.g. Google Docs).

The proposed solution is web-based because the web is a universal, open platform that allows the solution to be freely copied, modified, and deployed without gatekeepers. The web implementation may also serve as a reference for native platforms while offering cross-platform deployment options through PWAs and Electron. Later integration with a WASM based Bee node in the browser is also possible. Throughout the design, we prioritize feasibility and interoperability with mobile and desktop applications.

## Components

### Option 1: Trusted Domain with IFrame

In this setup there would be a Trusted Domain (e.g. `id.ethswarm.org`) where people could create accounts and keystores and there would be a UI to help this and also to later manage the keystore and permissions.

Apps would need to use a Library to access the keystore. The Library would load code from the Trusted Domain in an Iframe and would set up a secure communication channel so that the app can invoke operations using keys from the keystore.

Advantages of this approach:

- There is no need to install anything, the user just visits the website of the app

Disadvantages:

- The Trusted Domain is a single point of failure or a centralization point. In case it is not working or blocked then the App cannot be loaded either. This puts a burden on the future maintainers of the trusted domain website.
- Storing keys locally would either use localStorage or IndexedDB, but both can be challenging with IFrames due to Safari ITP

**Note:** After discussion with the team this option is the one that satisfies all the criteria, so this is what we are going to implement.

### Option 2: Browser Extension

In this setup the Browser Extension would be responsible for storing the keys securely and it would have a User Interface for managing the keys. It would set up the Library for applications for trusted communications.

Advantages:

- Fully self custodial and once the Extension is installed the user can always have access to the local copy of keys
- Familiar setup for existing wallet users

Disadvantages:

- The Extension needs to be installed and that may cause friction for adoption
- The distribution channel is an App Store that is controlled by gatekeepers with arbitrary rules that may change anytime

**Note:** After discussion with the team it turns out that this option does not satisfy the criteria that the user does not have to install anything, so this is not part of the PoC.

### Other options

There are other possible configurations. The Library can be also made to access a keystore app deployed in the Swarm Desktop app or other desktop apps via a local API. The same API can be used to serve the UI statically, also deployed in the desktop app.

Also different approaches can be used at the same time, they are not mutually exclusive.

## User flow

There would be a User Interface in a trusted environment that would allow managing different accounts (identities or personas), similarly to how an Ethereum wallet works. It would keep track of all the secrets/identifiers shared with the users in their apps, manage postage stamps and approvals for resources for apps.

### Creating an account

The proposed solution offers multiple ways to create an account, with Passkey for the most convenient way and SIWE for more advanced users who are already familiar with Ethereum wallets or want to reuse their node keys or simply want to have fully self-custodial key management.

#### Passkey/WebAuthn

Use the browser’s builtin Passkey flow to generate a credential for a given app. Usually this handles key management, so if you don’t have a passkey on a computer you can generally scan a code with your phone and authenticate from there.

#### SIWE

This method relies on an already installed Ethereum Wallet, either built-in the browser, as a browser extension or a separate app (typically on mobile). The user has to sign a message locally, so there is no blockchain involved and therefore no payment is necessary.

Both methods are similar in the sense that the end result of the interaction is a signed challenge that can be used as entropy for generating other secret keys.

### Unlocking an account

When the user wants to access their data stored in their key storage, to manage their account it needs to be unlocked (after a certain time of inactivity), similarly to an Ethereum wallet. Unlocking an account can be done similarly as when creating an account, using Passkey or Wallet. Alternatively a password can be provided.

### Connecting an app

When an app is used the first time the Extension needs to be connected with the app, similarly to Ethereum applications. With the Trusted Domain model the user would be redirected to the trusted domain and they would need to approve the app, similarly to how OAuth works. The app may request for permissions to access certain resources that the Keystore may store. It is possible to set up the permissions in a granular way so that for certain actions the app would no longer need user interaction (e.g. for signing), but this can be done for each resource and also the permissions may have a time element (e.g. give access for a month).

### App interactions

After connecting, the user may interact with the app and use different features of Swarm via the BeeJS library which can be augmented with the Identity Library, so that when a signing operation (feed update, postage stamp etc.) is required either an approval can be asked from the user or the user may choose to delegate the approval for the library and in that case it may happen automatically without further interaction from the user.

There should be a way for the user to view existing apps/approvals and manage them (add/import keys, revoke approvals etc.)

Ideally the apps are not supposed to have access to the keys, only have an interface for requesting operations that require the keys from the Keystore (e.g. signing).

## Key storage

The secrets and credentials can be stored in an encrypted wallet file. The encryption key can be also derived from the entropy provided by the account creation flow. This way accessing the keys can be passwordless for the user once they authenticate with a key, while providing strong security.

The wallet can be stored either locally or online, on Swarm. Both approaches have pros and cons and a good tradeoff seems to be to store everything online but keep a local copy, because the online version may be lost due to an expired postage stamp or some other unforeseen event.

Still it is easier to start with local only, because having two versions will inevitably lead to synchronization issues and conflict management. Import and export can be easily added and after that the full online version can be done at a later stage.

### Hierarchical data

The access levels can be represented with a DAG, where the nodes represent secret keys or resource identifiers. Each node may have subnodes that are either derived with a known schema (HD) or are storing random keys (feed identifiers etc.).

The postage stamps and approvals also need to be stored in the key storage.

The current vision is that the hierarchy would contain a master key at the root node, derived deterministically from the key used at account creation time. Then the children nodes could be application specific keys derived deterministically from the master key and the app domain together and they could contain application specific data.

When approving an application a subtree of the app domain can become accessible for the app with a choice of non-interactive signing, manual signing or a combination of these.

### Key types

It is important to differentiate between key types based on their value. Some keys may be regarded as **low-stakes** **keys,** such as session keys (e.g. feed keys that are generated for a limited lifetime). They can be considered to be shared with the application code directly.

There are also **high-stakes keys** that have either direct or indirect monetary value (e.g. postage stamp) or are randomly generated private keys where the public key is shared with someone else and therefore it is out of the wallet’s control to change it or update it. For example ACT keys are such keys. These keys are not supposed to be shared with the application directly, because it cannot be trusted that the application itself is not going to leak those. They can be protected with extra encryption inside of the Keystore and therefore they can be unlocked by higher privilege keys.

## Network access

The network can be accessed with the following modes:

- Bee node (e.g. Swarm Desktop, full node)
- Gateway node (may not be fully trusted)
- Bee in browser (with WASM, currently experimental)

In theory all three options can be supported. With the Gateway node the trust level is not the same as with the other options, but for certain applications even that trust level may be well enough.

Certain functionalities at the moment are only implemented in Bee in Go language. It would be good to have a Javascript native implementation of those functionalities that are above the Chunk API in Bee (encryption, ACT etc.). There is also the opposite effort to put Bee in the browser with WASM. When these become available then they would give a lot of freedom to tailor optimized solutions for very different use-cases.

API levels (from broader to narrower):

## Expected outcomes

The end result would be a proof-of-concept prototype that would demonstrate basic user-flows with a pre-agreed set of use-cases. It would contain a Javascript library published to NPM that would augment BeeJS with the Swarm Identities. It would contain a Browser Extension or the Trusted Domain UI/website and either a demo app or an integration with an existing app that would be published on the internet so that everyone can try it out. At this point it is not clear what would be the best solution for mobile, our hypothesis is that once the web version is built and used and well-understood then a mobile version can be considered as well.

Another expected outcome is a better understanding of how apps could be implemented on top of Swarm’s decentralized primitive features (SoC, ACT, feeds etc.) and what are the different trade-offs for using these features alone and together. The expectation is that such a solution would provide clarity on trust boundaries and practical considerations for security best practices. Finally it could show what are the areas where the current APIs are lacking or do not match developer expectations.

#### Non goals

It is not a goal of this proposal to create a solution for managing node identities (e.g. Clef). The concept will be usable to store node keys derived from a certain master key (as well as any other keys) but it is not part of the discovery to understand node operators’ issues and solve them.

It is also not a goal to create new cryptography primitives and solve the issue of Post-Quantum cryptography. The proposed solution builds on Swarm’s built-in cryptography and considers that good enough for the scope of the project. The assumption is that if that is not enough anymore then Swarm should upgrade the built-in cryptography primitives and then all applications built on Swarm may profit from that.

## Resources used:

- [Identity Management Research - Project Canvas](https://docs.google.com/document/d/1ioF4lzbWHbOkRvZq4Snf1KO5GK46bvvptbqmSPlJ78w/edit?tab=t.0)
- [Node identity // User identity](https://docs.google.com/presentation/d/1oaIIOly8S7Bw8Bt1UyYgygVk672QYiLyDQq9JoMScJI/edit?usp=sharing)
- [WebAuthn and Passkeys](https://www.webauthn.me/passkeys)
- [Sign in with Ethereum](https://siwe.xyz/)
- [Swarm Documentation](https://docs.ethswarm.org/)
- [Bee API | Swarm Documentation](https://docs.ethswarm.org/api/)
- [ethersphere/swarm-extension](https://github.com/ethersphere/swarm-extension)
- [https://www.npmjs.com/package/ses](https://www.npmjs.com/package/ses)
- [Delegation Toolkit introduction | MetaMask developer documentation](https://docs.metamask.io/delegation-toolkit/)
- [https://github.com/MetaMask/metamask-extension/blob/main/docs/architecture.png](https://github.com/MetaMask/metamask-extension/blob/main/docs/architecture.png)
- [https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)
- [https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki)
- [Understanding Safari's Intelligent Tracking Prevention (ITP) and Its Impact](https://www.customerlabs.com/blog/understanding-safari-intelligent-tracking-prevention-apple-itp-impact/)
-
