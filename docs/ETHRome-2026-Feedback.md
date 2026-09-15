# ETHRome 2026: what integrators told us

Five teams integrated Swarm ID over the weekend of 12–14 September 2026. Four wrote about
it; one only left comments in code. Each claim below was checked against the code, the
docs, and the live gateways on 15 September, and is marked accordingly. Where it held up,
an issue exists; where it was already known, the existing issue is linked; where it was
wrong, it says why, because two of the wrong beliefs were held by more than one team.

| Team              | Source                                                                                                                | SDK                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| apiritivo         | [README gotchas](https://github.com/pf55351/apiritivo-eth-26/tree/main/packages/swarm)                                | 0.4.1                      |
| unflat-agents     | [swarm/README.md](https://github.com/alexanderpi007/unflat-agents/blob/main/swarm/README.md)                          | 0.4.1                      |
| Ancorhash         | [swarm/friction.md](https://github.com/N0g4D/azure-web3-notarizer/blob/ethrome-2026/swarm/friction.md)                | 0.4.0                      |
| healthsend        | [docs/identity-and-onboarding.md](https://github.com/limone-eth/healthsend/blob/main/docs/identity-and-onboarding.md) | 0.4.1                      |
| agent-memory-mesh | [src/swarm.mjs](https://github.com/LevRoz630/agent-memory-mesh/blob/master/src/swarm.mjs) (comments only)             | none: bee-js 13.1 directly |
| Vespro            | [swarm/notes.md](https://github.com/fac3m4n/vespro/blob/main/swarm/notes.md)                                          | 0.4.1                      |

## What worked

Every team that shipped said the same thing in their own words: once an identity with a
usable drive was connected, encrypted upload and retrieval did what the README promised,
with no Bee node, no xBZZ and no seed handling on the critical path. Vespro's phrasing:
"there is no server-side upload path in this codebase to abuse", which is the property
the design exists to give them. Ancorhash: "that part is genuinely excellent."

## The themes

### 1. The session says it can upload when it cannot

The single most expensive finding, seen by three teams and reproduced on a real iPhone.
`canUpload` and `uploadMode: "user-stamp"` were true for accounts whose stamp could not
stamp: an expired drive (the phone run), a batch the node did not have (Ancorhash), and,
per the demo's own sidebar, a drive that `getPostageBatch()` could not even find. The
failure then arrived late and mislabelled: a 30-second timeout, or "No partition
available — all slots are held by other devices", which is the write coordinator reading
its first refused stamped write as contention.

- Cause: the readiness rule was "a batch id, a signer key and a stamper object exist", and
  the stamper builds from the stored record whatever its state.
- Fixed for the expired case in [#755](https://github.com/snaha/swarm-id/pull/755)
  (closes [#745](https://github.com/snaha/swarm-id/issues/745)): the stored lifetime is
  aged the way the identity UI already does, and an expired drive reports
  `uploadUnavailableReason: "stamp-expired"` and refuses the write before the coordinator.
- Open: the stored `exists` / `usable` fields
  ([#765](https://github.com/snaha/swarm-id/issues/765)), and the 30-second default
  request timeout that bounds uploads while the demo quietly uses ten minutes
  ([#762](https://github.com/snaha/swarm-id/issues/762)).
- Ancorhash now bypasses the flag entirely and checks `getPostageBatch()` themselves.
  Their line: "a readiness flag that can be wrong is worse than no flag."

### 2. A dApp's own connect button "loses the popup handover" — it does not

Three teams (apiritivo, unflat-agents, healthsend) independently concluded that on
partitioned storage, `client.connect()` from their own button opens the popup from the
parent, so `window.opener` is not the iframe and the session never arrives; all three
switched to rendering the proxy's own button. Two cited
[#613](https://github.com/snaha/swarm-id/issues/613), fixed in 0.4.0, while running 0.4.1.

Measured false. With popup blockers **on**, Chrome 151, Brave 1.93 (default Shields),
Firefox 144 and iOS Safari 26.6 all let the cross-origin iframe open the delegated popup
after the parent's click, and the handover completed
([#751](https://github.com/snaha/swarm-id/issues/751)). What the teams actually hit was
their own iframe being destroyed: healthsend rendered the button container only in the
signed-out branch, so signing in unmounted it and every later popup had a dead opener.
Apiritivo's README says "never recreate the iframe" for the same reason.

- The e2e rig could never observe this because every project disabled popup blocking, and
  Playwright's bundled Chromium never blocks a popup even without the flag. Fixed in
  [#756](https://github.com/snaha/swarm-id/pull/756): a `chrome-popup-blocked` project on
  the Chrome channel, with a control that proves the blocker is on.
- The docs never state that `connect()` works either way, which is why three teams guessed
  ([#760](https://github.com/snaha/swarm-id/issues/760)).

### 3. A new account cannot upload, and the docs did not say so

Every fresh Swarm ID has no drive. Without a `subsidisedGatewayUrl` the first upload of
every first-time user fails with `no-stamp`. Apiritivo found the working value by reading
the demo's source. Vespro called the behaviour "the right model" and only wished the
reason surfaced earlier.

- Docs fixed in [#757](https://github.com/snaha/swarm-id/pull/757) (closes
  [#753](https://github.com/snaha/swarm-id/issues/753)): the getting-started example
  passes the public gateway, and a note explains the two responses.
- The gift code handed out at the desk is a funded drive, not an identity, and the product
  path to attach it (Add drive, "Use existing batch") is undocumented
  ([#764](https://github.com/snaha/swarm-id/issues/764)).

### 4. The public gateway, discovered one piece at a time

Four teams each learned one thing about `api.gateway.ethswarm.org` the hard way, and one
used the wrong host altogether.

| What they hit                                                                                                                    | Verified | Where it went                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pin: true` fails as "Failed to fetch" (CORS allow-list has no `Swarm-Pin`)                                                      | yes      | [#754](https://github.com/snaha/swarm-id/pull/754) drops it on the subsidised path; [ethersphere/gateway-proxy#533](https://github.com/ethersphere/gateway-proxy/issues/533) asks the proxy to expose its allow-list so clients can feature-detect |
| `getNodeInfo()` fails (no `/node`)                                                                                               | yes, 404 | [#763](https://github.com/snaha/swarm-id/issues/763)                                                                                                                                                                                               |
| no `/stamps`, so batch details fall back to the stored snapshot                                                                  | yes, 404 | noted on [#765](https://github.com/snaha/swarm-id/issues/765)                                                                                                                                                                                      |
| `/bytes` with a batch id ignores the id and stamps with the gateway's own; own-batch uploads only via envelope-stamped `/chunks` | yes      | [#771](https://github.com/snaha/swarm-id/issues/771)                                                                                                                                                                                               |
| `/bzz/<ref>` 308-then-404 for a raw-bytes reference                                                                              | yes      | [#767](https://github.com/snaha/swarm-id/issues/767)                                                                                                                                                                                               |
| `gateway.ethswarm.org` (the web gateway) answers 200 with HTML for any address, 405 for uploads                                  | yes      | [#766](https://github.com/snaha/swarm-id/issues/766)                                                                                                                                                                                               |

[#771](https://github.com/snaha/swarm-id/issues/771) asks for one page with all of it.

### 5. Docs and API surface that misled

- Quick Start's progress example passes the callback as a third argument and reads
  `progress.percent`; neither exists ([#758](https://github.com/snaha/swarm-id/issues/758)).
- `utilization` is documented as a percentage; it is Bee's fullest-bucket count, and one
  team derived the real formula themselves
  ([#772](https://github.com/snaha/swarm-id/issues/772)).
- Upload and download come in pairs and nothing says so; one team crossed them one way
  (`downloadFile` on an `uploadData` reference, failing inside the Mantaray parser), another
  the other way (`/bzz` links for `uploadData` output)
  ([#767](https://github.com/snaha/swarm-id/issues/767)).
- The introduction still describes iframe storage as always partitioned; the architecture
  page says otherwise ([#760](https://github.com/snaha/swarm-id/issues/760)).
- The client warns on every window message from another origin before checking the source,
  so React DevTools, Vite and Next.js HMR trip "Rejected message from unauthorized origin"
  several times a second. Two teams chased it
  ([#759](https://github.com/snaha/swarm-id/issues/759)).
- Proxy errors reach the dApp as one string, with status and cause flattened away; the
  team that built diagnostics had to print "not supplied by SDK"
  ([#761](https://github.com/snaha/swarm-id/issues/761)).
- The connect popup's "Check storage" row action, which is a drive-expiry warning, was read
  by healthsend as a browser-storage grant step and became the centrepiece of their
  onboarding critique ([#768](https://github.com/snaha/swarm-id/issues/768)).

### 6. Two audiences we do not serve yet

- **Agents and servers.** agent-memory-mesh did not use the library at all: "an
  iframe-based browser passkey flow, unusable from a server". They then rebuilt the
  stamper, batch partitioning and envelope uploads in 230 lines of Node. The docs never
  state the browser-only scope ([#770](https://github.com/snaha/swarm-id/issues/770)).
- **dApps that want no third context.** healthsend's design after a weekend is to self-host
  the identity UI same-site with their app, which is how the DigitalOcean deployment
  already runs; they costed the trade-offs (passkey RP-ID portability, owning recovery)
  correctly and had to derive all of it from the repository
  ([#769](https://github.com/snaha/swarm-id/issues/769)).

## Claims that did not hold

- "A parent-page button loses the popup handover; allow popups for the identity service."
  See theme 2.
- "Sign-in accepts a seed phrase and nothing else." The UI offers passkey, password and
  Ethereum-wallet unlock; a fresh device restores from the recovery phrase by design. The
  real gap is the gift-code flow ([#764](https://github.com/snaha/swarm-id/issues/764)).
- "Check storage opens a third tab to establish first-party storage." It is a drive-expiry
  warning that a fresh account never sees ([#768](https://github.com/snaha/swarm-id/issues/768)).
- "The gateway accepted stamps for every depth from 16 to 30, so it validates the signature
  but not the slot index." Bee's `Stamp.Valid` checks the within-bucket index against the
  batch's real depth; a few uploads per bucket never reach an index that would fail.
- "Deferred upload mode is required" on the public gateway. The demo probes the node mode
  to choose it, the probe 404s there, and the default stays off; the team copied a setting
  the demo never applies ([#763](https://github.com/snaha/swarm-id/issues/763)).

## Everything opened from this round

Pull requests: [#754](https://github.com/snaha/swarm-id/pull/754) pin on the subsidised
path · [#755](https://github.com/snaha/swarm-id/pull/755) expired drive not uploadable ·
[#756](https://github.com/snaha/swarm-id/pull/756) popup-blocker e2e ·
[#757](https://github.com/snaha/swarm-id/pull/757) new-account docs.

Issues: [#751](https://github.com/snaha/swarm-id/issues/751) · [#752](https://github.com/snaha/swarm-id/issues/752) ·
[#753](https://github.com/snaha/swarm-id/issues/753) · [#758](https://github.com/snaha/swarm-id/issues/758) ·
[#759](https://github.com/snaha/swarm-id/issues/759) · [#760](https://github.com/snaha/swarm-id/issues/760) ·
[#761](https://github.com/snaha/swarm-id/issues/761) · [#762](https://github.com/snaha/swarm-id/issues/762) ·
[#763](https://github.com/snaha/swarm-id/issues/763) · [#764](https://github.com/snaha/swarm-id/issues/764) ·
[#765](https://github.com/snaha/swarm-id/issues/765) · [#766](https://github.com/snaha/swarm-id/issues/766) ·
[#767](https://github.com/snaha/swarm-id/issues/767) · [#768](https://github.com/snaha/swarm-id/issues/768) ·
[#769](https://github.com/snaha/swarm-id/issues/769) · [#770](https://github.com/snaha/swarm-id/issues/770) ·
[#771](https://github.com/snaha/swarm-id/issues/771) · [#772](https://github.com/snaha/swarm-id/issues/772) ·
upstream [ethersphere/gateway-proxy#533](https://github.com/ethersphere/gateway-proxy/issues/533).

Comments added to existing issues: [#524](https://github.com/snaha/swarm-id/issues/524)
(bee-js audit findings and a consumer on 13.x), [#745](https://github.com/snaha/swarm-id/issues/745)
(the phone run), [#752](https://github.com/snaha/swarm-id/issues/752) (upstream follow-up).

## If only three things get done

1. Make readiness true ([#765](https://github.com/snaha/swarm-id/issues/765) on top of
   [#755](https://github.com/snaha/swarm-id/pull/755), and
   [#762](https://github.com/snaha/swarm-id/issues/762)). Every team gated their UI on
   `canUpload`, exactly as the README told them to.
2. Write the gateway page ([#771](https://github.com/snaha/swarm-id/issues/771)) and the
   pairing lines ([#767](https://github.com/snaha/swarm-id/issues/767)). Cheap, and they
   cover four teams' lost hours.
3. Say in the docs that `connect()` works on partitioned storage and that the iframe must
   stay mounted ([#760](https://github.com/snaha/swarm-id/issues/760)). Three teams
   rebuilt their sign-in around a bug that was fixed before the event.
