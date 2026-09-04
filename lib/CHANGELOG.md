# Changelog

## [0.4.0](https://github.com/snaha/swarm-id/compare/v0.3.0...v0.4.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **lib:** a partition lane belongs to one batch, not to the account ([#683](https://github.com/snaha/swarm-id/issues/683))
* **lib:** the lease cache is keyed per batch, like the lease it caches ([#685](https://github.com/snaha/swarm-id/issues/685))
* **lib:** a connected app's membership merges on the markers that state it ([#682](https://github.com/snaha/swarm-id/issues/682))
* **lib:** `UploadUnavailableReason` no longer includes `"download-only"`, and `AuthData.account` is required. An already-persisted partition session carrying no `account` fails `PartitionSessionSchemaV1` on restore and is cleared, forcing a fresh re-auth on next load — those are exactly the revoke-deaf sessions this removes.
* **lib:** the chain reads in `@snaha/swarm-id` now carry a 10 second deadline (`CHAIN_READ_TIMEOUT_MS`) where they previously waited as long as the endpoint held the socket. This affects `getBlockTimestamp` and the PostageStamp contract reads built on the `eth_call` batch — `fetchOnChainBatchState`, `fetchOnChainBatchStateResult`, `fetchBatchTTLFromContract`, `fetchAuthoritativeBatchTTL` and `resolveBatchStatus` — which now reject (or settle to their `undefined` / `status: 'error'` result) once it passes, rather than hanging. The messages they throw changed with it, so anything matching on message text rather than catching needs updating. No export was removed: `postJsonRpc` and the `chunking-encrypted` merkle builder were never in the published surface.
* **lib:** `rejectAfter` is no longer exported from @snaha/swarm-id. Use `withTimeout(work, ms, message)` instead.

### Features

* account bus — live state propagation across tabs, partitions, and devices ([#547](https://github.com/snaha/swarm-id/issues/547)) ([5a3cfbd](https://github.com/snaha/swarm-id/commit/5a3cfbdbc9f9a4ffbee5d1245615fc0e8d0144a6))
* consume account-delta so a revoke reaches a partitioned iframe ([#598](https://github.com/snaha/swarm-id/issues/598)) ([bd47f98](https://github.com/snaha/swarm-id/commit/bd47f9875d75b07cae22e01fba808e671b67881f))
* **demo:** a self-reporting Safari check for the partitioned upload path ([#606](https://github.com/snaha/swarm-id/issues/606)) ([8b36aec](https://github.com/snaha/swarm-id/commit/8b36aecd3c7c7ec8d1f2ac489f0fc8677bbd9956))
* hand a partitioned session only the stamps its app can spend ([#601](https://github.com/snaha/swarm-id/issues/601)) ([0f6636c](https://github.com/snaha/swarm-id/commit/0f6636c8c3c5fdea9e5f7d627601779d1989a179))
* harden the account-bus signaling service ([#592](https://github.com/snaha/swarm-id/issues/592)) ([c00ba6e](https://github.com/snaha/swarm-id/commit/c00ba6e4764a4cbf14a1b47603a9c820e1b76af2))
* **lib:** a departing peer leaves the live set at once ([#669](https://github.com/snaha/swarm-id/issues/669)) ([b565e65](https://github.com/snaha/swarm-id/commit/b565e651f92525b4b01d14942ef2e9a3f5b501b7))
* **lib:** add deriveAppSecret(label) to the client API ([#530](https://github.com/snaha/swarm-id/issues/530)) ([09a1cc5](https://github.com/snaha/swarm-id/commit/09a1cc506d60d999587ddc6ec698be39b3b9b53d)), closes [#520](https://github.com/snaha/swarm-id/issues/520)
* **lib:** export withTimeout/TimeoutError and drop rejectAfter ([#553](https://github.com/snaha/swarm-id/issues/553)) ([ee18527](https://github.com/snaha/swarm-id/commit/ee18527a9865ebb954e8949b0f824f91a18e6c52))
* **lib:** keep a partitioned session across a reload ([#636](https://github.com/snaha/swarm-id/issues/636)) ([af35287](https://github.com/snaha/swarm-id/commit/af35287f8b385d773a6386715b14fd8b0b1add74))
* **lib:** name a partition device after the dApp it belongs to ([#643](https://github.com/snaha/swarm-id/issues/643)) ([4bdc2d0](https://github.com/snaha/swarm-id/commit/4bdc2d01ba7577348f71929dbcd89b4f73f2b0ff)), closes [#570](https://github.com/snaha/swarm-id/issues/570)
* **lib:** one JSON-RPC contract and one deadline, across every transport ([#554](https://github.com/snaha/swarm-id/issues/554)) ([4c4ab6a](https://github.com/snaha/swarm-id/commit/4c4ab6afc42478e906fd2ed7976584f5adbbaf20))
* **lib:** presence heartbeat on the account bus ([#655](https://github.com/snaha/swarm-id/issues/655)) ([b20c379](https://github.com/snaha/swarm-id/commit/b20c37989a71fc9065d0679672c09c4e49936b6a))
* **lib:** remove the download-only session ([#642](https://github.com/snaha/swarm-id/issues/642)) ([304004a](https://github.com/snaha/swarm-id/commit/304004a27f35613111d8196316831169906151dc)), closes [#599](https://github.com/snaha/swarm-id/issues/599)
* **payment:** pay from any chain over Relay, and rehearse it locally ([#534](https://github.com/snaha/swarm-id/issues/534)) ([d146cc2](https://github.com/snaha/swarm-id/commit/d146cc242dfe1928bc671cff6f328bec927415e0))
* **ui:** fold a peer's account-delta into shared storage ([#631](https://github.com/snaha/swarm-id/issues/631)) ([f431d3f](https://github.com/snaha/swarm-id/commit/f431d3f129a8e7bd26663f7d940eab14f5489de9))
* **ui:** publish account-delta from the SwarmID tab ([#600](https://github.com/snaha/swarm-id/issues/600)) ([372b5bf](https://github.com/snaha/swarm-id/commit/372b5bfb0bf5b0e191f3dceb8364a0aa39bff555))


### Bug Fixes

* elect one holder per lease-request, and stop losing the wake ([#593](https://github.com/snaha/swarm-id/issues/593)) ([430ff5b](https://github.com/snaha/swarm-id/commit/430ff5bbdf97926d8136205a4c5ac397139d323b))
* harden account-delta propagation and folding ([#610](https://github.com/snaha/swarm-id/issues/610)) ([5659fe9](https://github.com/snaha/swarm-id/commit/5659fe9652cdd4172ceb6ef9943d511c8b59c975))
* **lib:** a connected app's membership merges on the markers that state it ([#682](https://github.com/snaha/swarm-id/issues/682)) ([e0b6d82](https://github.com/snaha/swarm-id/commit/e0b6d82074982b3cf5e8c9315b86c957c43a3ac1)), closes [#681](https://github.com/snaha/swarm-id/issues/681)
* **lib:** a device rename carries its own clock ([#665](https://github.com/snaha/swarm-id/issues/665)) ([ac9d507](https://github.com/snaha/swarm-id/commit/ac9d50700d6b4142dbfbe1761cc817a373c0d000)), closes [#663](https://github.com/snaha/swarm-id/issues/663)
* **lib:** a device tombstone survives the poll that used to undo it ([#644](https://github.com/snaha/swarm-id/issues/644)) ([e0a1646](https://github.com/snaha/swarm-id/commit/e0a1646ff6cf486a62b3132f2a63034cf5471e49))
* **lib:** a Disconnect ends a restored session, not just a Remove ([#668](https://github.com/snaha/swarm-id/issues/668)) ([56bc430](https://github.com/snaha/swarm-id/commit/56bc430cd818fb0322ca115dd6a9adc24da0b51e)), closes [#667](https://github.com/snaha/swarm-id/issues/667)
* **lib:** a partition lane belongs to one batch, not to the account ([#683](https://github.com/snaha/swarm-id/issues/683)) ([2e8962f](https://github.com/snaha/swarm-id/commit/2e8962fe8ae053313094fb452f398c804196a979)), closes [#589](https://github.com/snaha/swarm-id/issues/589)
* **lib:** a partitioned session is stored per dApp origin ([#672](https://github.com/snaha/swarm-id/issues/672)) ([d9c99a7](https://github.com/snaha/swarm-id/commit/d9c99a707599f7007998583c653a615f894672e5)), closes [#671](https://github.com/snaha/swarm-id/issues/671)
* **lib:** a poll no longer stamps lastSignedInAt ([#654](https://github.com/snaha/swarm-id/issues/654)) ([f1cfbdf](https://github.com/snaha/swarm-id/commit/f1cfbdff7949ebd027e6d1c7f52034d84c79c8ef)), closes [#652](https://github.com/snaha/swarm-id/issues/652)
* **lib:** a refused handover ends the attempt it belonged to ([#678](https://github.com/snaha/swarm-id/issues/678)) ([d11a0f9](https://github.com/snaha/swarm-id/commit/d11a0f98785ce6aeb532ee426b8e4053ae4d548b)), closes [#587](https://github.com/snaha/swarm-id/issues/587)
* **lib:** a restore keeps the connect instant it was handed ([#675](https://github.com/snaha/swarm-id/issues/675)) ([dba3131](https://github.com/snaha/swarm-id/commit/dba313196d739e0938d3655ebbd3d8dcd25280ce)), closes [#670](https://github.com/snaha/swarm-id/issues/670)
* **lib:** a storage event cannot reset a partitioned session to defaults ([#677](https://github.com/snaha/swarm-id/issues/677)) ([628dd6f](https://github.com/snaha/swarm-id/commit/628dd6f382cc3c1d34aa848dbf659e8b0b8fdc94)), closes [#580](https://github.com/snaha/swarm-id/issues/580)
* **lib:** flush ICE candidates for the connection that was described ([#603](https://github.com/snaha/swarm-id/issues/603)) ([0f89a65](https://github.com/snaha/swarm-id/commit/0f89a65464672dabf4cb7f0467c4e1be9eb7f3e4))
* **lib:** persist a device-registry merge on content, not on length ([#602](https://github.com/snaha/swarm-id/issues/602)) ([a686217](https://github.com/snaha/swarm-id/commit/a68621731383a911e2fc95b32d65161386f0ecd4))
* **lib:** repoint proxy Bee client when the node URL changes ([#529](https://github.com/snaha/swarm-id/issues/529)) ([3837233](https://github.com/snaha/swarm-id/commit/3837233599483812a827e57858cc5bbbf38b68d2)), closes [#515](https://github.com/snaha/swarm-id/issues/515)
* **lib:** route the auth popup by storage mode, not by user agent ([#630](https://github.com/snaha/swarm-id/issues/630)) ([46a60e5](https://github.com/snaha/swarm-id/commit/46a60e56e86b2369cd1cd4a12008d6e475d073f8))
* **lib:** the lease cache is keyed per batch, like the lease it caches ([#685](https://github.com/snaha/swarm-id/issues/685)) ([2a264ef](https://github.com/snaha/swarm-id/commit/2a264efe7b6adc2874d6c9e438bd834de37ccb94)), closes [#684](https://github.com/snaha/swarm-id/issues/684)
* name the bus room in the first frame, not the query string ([#605](https://github.com/snaha/swarm-id/issues/605)) ([5f639b7](https://github.com/snaha/swarm-id/commit/5f639b7f4e085298a954ef4f791215afc7cdbc58))
* scope the local bus channel to the account ([#594](https://github.com/snaha/swarm-id/issues/594)) ([56caaef](https://github.com/snaha/swarm-id/commit/56caaef72689e5eeaf28aa06e78a5a68dda5c19a))
* split the Safari check's handover verdict from its writer verdict ([#616](https://github.com/snaha/swarm-id/issues/616)) ([fce6721](https://github.com/snaha/swarm-id/commit/fce672146b4b79e0ee216cffb86137fac635545c))
* **ui:** stop offering drive sizes with no usable capacity ([#565](https://github.com/snaha/swarm-id/issues/565)) ([d817e74](https://github.com/snaha/swarm-id/commit/d817e74a021b67ceddd205c6dbae0289e269f38a)), closes [#538](https://github.com/snaha/swarm-id/issues/538)

## [0.3.0](https://github.com/snaha/swarm-id/compare/v0.2.0...v0.3.0) (2026-08-10)


### ⚠ BREAKING CHANGES

* **lib:** `ConnectionInfo.identity` gains a required `avatar`, and the `connectionInfoChanged` message carries it. A client on this version rejects that message from a proxy predating it — and `initialize()` awaits the first one — so the dApp-side library and the Swarm ID deployment must be upgraded together. The library is unreleased, so no published consumer is affected.
* **lib:** UploadOptions no longer accepts redundancyLevel (it was validated but never forwarded), and ButtonStyles/ButtonStylesSchema are no longer exported from @snaha/swarm-id. Both were no-ops; remove them from call sites.
* **ui:** renames AccountSchemaV1 -> LocalAccountSchemaV1, AccountDataSchemaV1 -> SyncedAccountSchemaV1, AccountData -> SyncedAccount, serializeAccountData -> serializeSyncedAccount, foldedToAccountData -> foldedToSyncedAccount; adds LocalVaultSchemaV1, SignedInAccount/SignedOutAccount/LocalVault types; AccountsStoreInterface.getAccount now returns the SyncedAccount projection (the sync seam never sees the vault).
* **lib:** evictOldEntries and CacheEvictionPolicy are no longer exported from @snaha/swarm-id.

### Features

* **lib:** cut cold partition-acquire latency ~5x ([#451](https://github.com/snaha/swarm-id/issues/451)) ([ba23224](https://github.com/snaha/swarm-id/commit/ba23224e061ce103358921df7cc1ae23db6bcdcc))
* **lib:** expose account avatars through the client API (breaking wire change) ([#509](https://github.com/snaha/swarm-id/issues/509)) ([63c56c4](https://github.com/snaha/swarm-id/commit/63c56c4d82a566151b71c156640f1f0fb2b0f13a))
* sign back in to a signed-out account with the security method ([#498](https://github.com/snaha/swarm-id/issues/498)) ([6498d35](https://github.com/snaha/swarm-id/commit/6498d3500b81cc315e1d560b5143b9aef10afe4d))
* **ui:** section the connect chooser and skip the done page with a drive ([#500](https://github.com/snaha/swarm-id/issues/500)) ([af702c1](https://github.com/snaha/swarm-id/commit/af702c156a775e0aac26dfc214ed1f97d74e86c2))
* **ui:** sign-out flow for synced accounts ([#442](https://github.com/snaha/swarm-id/issues/442)) ([bba1988](https://github.com/snaha/swarm-id/commit/bba19882cd9f9f1e1ae3a7d507d497d049c3ffea))


### Bug Fixes

* converge dApp-only devices on peer account changes ([#456](https://github.com/snaha/swarm-id/issues/456)) ([cf7f564](https://github.com/snaha/swarm-id/commit/cf7f564e54d9270bc4a368e841fe673c99eed61b))
* **lib:** accept non-ACT download options; remove dead protocol paths ([#489](https://github.com/snaha/swarm-id/issues/489)) ([095d278](https://github.com/snaha/swarm-id/commit/095d27841faccc6cae35f4f078640baf8212fb7c)), closes [#420](https://github.com/snaha/swarm-id/issues/420)
* **lib:** confirm absent roster slots via GET /soc when /chunks 500s ([#458](https://github.com/snaha/swarm-id/issues/458)) ([1403cf2](https://github.com/snaha/swarm-id/commit/1403cf2958f00b13adc144e9793b829b5ae04ad5)), closes [#457](https://github.com/snaha/swarm-id/issues/457)
* **lib:** don't re-encrypt the content reference on ACT revocation ([#497](https://github.com/snaha/swarm-id/issues/497)) ([e53ffd4](https://github.com/snaha/swarm-id/commit/e53ffd4a6d950734f504f5217201a36cf3af6595)), closes [#496](https://github.com/snaha/swarm-id/issues/496)
* **lib:** remove unsafe utilization-cache LRU eviction ([#452](https://github.com/snaha/swarm-id/issues/452)) ([3a13df1](https://github.com/snaha/swarm-id/commit/3a13df1bf2001de61246e1d5a217684a326cac50))
* **lib:** stop logging the decryption key of encrypted references ([#480](https://github.com/snaha/swarm-id/issues/480)) ([0aa3590](https://github.com/snaha/swarm-id/commit/0aa359078b1567be1a8a84fbd3a12e115a046218))
* **lib:** upload zero-byte data and reject multi-chunk explicit encryption key ([#486](https://github.com/snaha/swarm-id/issues/486)) ([976f295](https://github.com/snaha/swarm-id/commit/976f29521e9eb6399bfb9423aeef39361723e626)), closes [#418](https://github.com/snaha/swarm-id/issues/418)
* **lib:** use 128-ref fanout for plain Merkle trees ([#488](https://github.com/snaha/swarm-id/issues/488)) ([5ea9f6a](https://github.com/snaha/swarm-id/commit/5ea9f6a1abc9b0d45b126f9d84bc695dfdf54959)), closes [#417](https://github.com/snaha/swarm-id/issues/417)
* **lib:** use random chunk-encryption padding like Bee ([#468](https://github.com/snaha/swarm-id/issues/468)) ([ead2e11](https://github.com/snaha/swarm-id/commit/ead2e11bf4da8af58dc60b756d527e6ada95b9f0)), closes [#409](https://github.com/snaha/swarm-id/issues/409)
* **lib:** validate ECDH public keys and replace hand-rolled secp256k1 ([#464](https://github.com/snaha/swarm-id/issues/464)) ([a211a3a](https://github.com/snaha/swarm-id/commit/a211a3a010cf00181c2578daaea1c1c2c92a1a4e)), closes [#407](https://github.com/snaha/swarm-id/issues/407)
* **lib:** validate parentIdentify and require it to come from the parent window ([#477](https://github.com/snaha/swarm-id/issues/477)) ([0f78d93](https://github.com/snaha/swarm-id/commit/0f78d9362338dbafaf3d10610a477c2cc8c2fa58)), closes [#410](https://github.com/snaha/swarm-id/issues/410)


### Performance Improvements

* **lib:** cut fold-from-Swarm over-reads on roster scan and epoch probes ([#454](https://github.com/snaha/swarm-id/issues/454)) ([9b02815](https://github.com/snaha/swarm-id/commit/9b028153494c585777704d33683b9e419bf5a851)), closes [#400](https://github.com/snaha/swarm-id/issues/400)

## [0.2.0](https://github.com/snaha/swarm-id/compare/v0.1.3...v0.2.0) (2026-07-07)


### ⚠ BREAKING CHANGES

* **lib:** removes the `passkey`/`ethereum`/`agent` account types and the per-type backup headers from `@snaha/swarm-id`. Consumers read a single account model; "local vs synced" is the runtime `isLocalAccount` predicate.
* `ClientOptions.onAuthChange` and `SwarmIdClient.getConnectionInfo()` are removed. Both were strict subsets of the new `onConnectionChange` / `client.connectionInfo` surface introduced in the previous commit.
* uint16 utilization counter ([#320](https://github.com/snaha/swarm-id/issues/320))

### Features

* emit ConnectionInfo changes from the iframe proxy ([#317](https://github.com/snaha/swarm-id/issues/317)) ([197b25c](https://github.com/snaha/swarm-id/commit/197b25cea12d3f4074e2a5aaca1d379e976430ae))
* extract a BatchWriteCoordinator from the proxy ([#346](https://github.com/snaha/swarm-id/issues/346)) ([380aabe](https://github.com/snaha/swarm-id/commit/380aabef6da8e0c50e193bd14aa142c96b2364d3))
* multi-device postage batch sharing + account-state sync ([#335](https://github.com/snaha/swarm-id/issues/335)) ([ab0c963](https://github.com/snaha/swarm-id/commit/ab0c96317492517edf4af5a36bdb1fff5faa987e))
* nested single-level account model ([#339](https://github.com/snaha/swarm-id/issues/339)/[#313](https://github.com/snaha/swarm-id/issues/313)) + multi-device read/pull ([#338](https://github.com/snaha/swarm-id/issues/338)) ([#367](https://github.com/snaha/swarm-id/issues/367)) ([6e93ef4](https://github.com/snaha/swarm-id/commit/6e93ef4b97d16c4f002fba71fbaca7a1b305dc1a))
* **stamps:** compute dev-page stamp amount from chainstate ([#325](https://github.com/snaha/swarm-id/issues/325)) ([8a538ac](https://github.com/snaha/swarm-id/commit/8a538acadd7942447b8c70d03b531ecfabdbe2b4))
* **sync:** add PartitionStateSchemaV1 + decode-time validation for the partition-state wire format ([#350](https://github.com/snaha/swarm-id/issues/350)) ([a7cfc96](https://github.com/snaha/swarm-id/commit/a7cfc9663ccd54c7400781b91595eee2ab00bba9)), closes [#340](https://github.com/snaha/swarm-id/issues/340)
* **sync:** crash-safe commit-ordered partition handoff + fast acquire/upload ([#382](https://github.com/snaha/swarm-id/issues/382)) ([8d4ac6f](https://github.com/snaha/swarm-id/commit/8d4ac6f0b3725545cadd41f5b04aec8de15c10f2))
* **sync:** intent SOCs resolve free-partition races across disjoint gateways ([#359](https://github.com/snaha/swarm-id/issues/359)) ([6cb8d4f](https://github.com/snaha/swarm-id/commit/6cb8d4fde8caf662f357382ab50dd97ff2684289))
* **sync:** multi-device account-state sync (tombstones + per-device feeds) ([#374](https://github.com/snaha/swarm-id/issues/374)) ([4c7ba25](https://github.com/snaha/swarm-id/commit/4c7ba25f6db6e772d8e2ca81a520b504d5bb7c37))
* **ui:** developer tools page on the unified account model ([#384](https://github.com/snaha/swarm-id/issues/384)) ([9099893](https://github.com/snaha/swarm-id/commit/9099893d79cb6dfa25ea5bddb3467e4f731f36a4))
* **ui:** sign-in recovery, product account sync (publish + fold), existing-batch attach ([#399](https://github.com/snaha/swarm-id/issues/399)) ([f79decc](https://github.com/snaha/swarm-id/commit/f79decc196047ecd5c3b062fe3b21e53d8459f55))
* **ui:** Storage tab for managing drives — buy, attach, rename, resize, extend ([#375](https://github.com/snaha/swarm-id/issues/375)) ([e6bf345](https://github.com/snaha/swarm-id/commit/e6bf3452a71a4f96026e7ee714f119e4aac75eb6))
* **ui:** unified account store ([#379](https://github.com/snaha/swarm-id/issues/379)) ([f990605](https://github.com/snaha/swarm-id/commit/f990605b7074ff1550c9105e90fa55aa6f578735))


### Bug Fixes

* **dev:** serve lib source in Vite dev for reliable HMR ([#352](https://github.com/snaha/swarm-id/issues/352)) ([a840617](https://github.com/snaha/swarm-id/commit/a840617d2486f6cf22b0e2114f7756711762b365)), closes [#347](https://github.com/snaha/swarm-id/issues/347)
* **lib:** arm init-timeout timers in initialize(), not the constructor ([#440](https://github.com/snaha/swarm-id/issues/440)) ([6180566](https://github.com/snaha/swarm-id/commit/6180566d6a78db23eaa41b0d5969c8392f366b7f)), closes [#421](https://github.com/snaha/swarm-id/issues/421)
* **lib:** don't treat read failures as a free slot in feed finder and roster ([#438](https://github.com/snaha/swarm-id/issues/438)) ([808b5d8](https://github.com/snaha/swarm-id/commit/808b5d80efb484c5304f2908a8f6731e328363fd)), closes [#415](https://github.com/snaha/swarm-id/issues/415)
* **lib:** migrate remaining rejectAfter races to withTimeout ([#398](https://github.com/snaha/swarm-id/issues/398)) ([cec89ad](https://github.com/snaha/swarm-id/commit/cec89ad8b09a15bd6641e4effd8e35aebcc1a036))
* **lib:** partition-aware bucket capacity check ([#439](https://github.com/snaha/swarm-id/issues/439)) ([a02e21c](https://github.com/snaha/swarm-id/commit/a02e21c931d52dae7bab07df09a5665c2ae5627a)), closes [#416](https://github.com/snaha/swarm-id/issues/416)
* postage batch id association ([#322](https://github.com/snaha/swarm-id/issues/322)) ([9bd3562](https://github.com/snaha/swarm-id/commit/9bd35620626290717cc86ba4afbbeb098da44aa8))
* show live postage stamp usable status in the demo app ([#353](https://github.com/snaha/swarm-id/issues/353)) ([a1833c9](https://github.com/snaha/swarm-id/commit/a1833c94b8f77ba82e42e43361abfa6381ff8bd3)), closes [#351](https://github.com/snaha/swarm-id/issues/351)
* **stamps:** compute stamp expiry from the PostageStamp contract ([#345](https://github.com/snaha/swarm-id/issues/345)) ([4376ead](https://github.com/snaha/swarm-id/commit/4376ead3e3c1c3d4766547ccc6b796e6ae5d5657))
* **sync:** fence the partition-lock release against re-acquire eviction ([#356](https://github.com/snaha/swarm-id/issues/356)) ([8d4f33d](https://github.com/snaha/swarm-id/commit/8d4f33d24d2ba5326accd990d1b4ace0ea44ffa2))
* **sync:** publish state pointer after its referenced chunks ([#432](https://github.com/snaha/swarm-id/issues/432)) ([4c8463e](https://github.com/snaha/swarm-id/commit/4c8463e24961422b8acd6a3590df0d1b79949378)), closes [#414](https://github.com/snaha/swarm-id/issues/414)
* **sync:** reuse lock generation on lease refresh ([#430](https://github.com/snaha/swarm-id/issues/430)) ([30058e2](https://github.com/snaha/swarm-id/commit/30058e28f6d98c525e00bb78791328bdc91daa7f)), closes [#413](https://github.com/snaha/swarm-id/issues/413)
* **ui:** derive unnamed drive fallback name from batch id ([#396](https://github.com/snaha/swarm-id/issues/396)) ([dc9e1cd](https://github.com/snaha/swarm-id/commit/dc9e1cd4221ddc206d03f7cf263b9080b25467b1))
* uint16 utilization counter ([#320](https://github.com/snaha/swarm-id/issues/320)) ([413d9ad](https://github.com/snaha/swarm-id/commit/413d9ad4336cd417dec6bac9bccf856138e220c7))
* use Bee node batchTTL for stamp expiry, show Expired badge ([#319](https://github.com/snaha/swarm-id/issues/319)) ([b4e25bf](https://github.com/snaha/swarm-id/commit/b4e25bff12145084a6e88dba4fdfc2ed7471ee3c))


### Code Refactoring

* **lib:** unify the account model — one BIP-39 seed account ([#377](https://github.com/snaha/swarm-id/issues/377)) ([e3e93e1](https://github.com/snaha/swarm-id/commit/e3e93e11808579045dd0676b70b15ef294df48cb))

## [0.1.3](https://github.com/snaha/swarm-id/compare/v0.1.2...v0.1.3) (2026-04-10)


### Features

* subsidised gateway ([#298](https://github.com/snaha/swarm-id/issues/298)) ([99f83a4](https://github.com/snaha/swarm-id/commit/99f83a449a75ec0d84a69a06971a68a60cfea4fd))

## [0.1.2](https://github.com/snaha/swarm-id/compare/v0.1.1...v0.1.2) (2026-04-01)


### Bug Fixes

* feed writer to use batch stamper ([#291](https://github.com/snaha/swarm-id/issues/291)) ([c78e60d](https://github.com/snaha/swarm-id/commit/c78e60d327b40718211eda75a537724affc77cbb))

## [0.1.1](https://github.com/snaha/swarm-id/compare/v0.1.0...v0.1.1) (2026-03-31)


### Features

* add public key to identity ([#282](https://github.com/snaha/swarm-id/issues/282)) ([6b41053](https://github.com/snaha/swarm-id/commit/6b410532147ee5a3f58004ff311e0baca3ebeb07))


### Bug Fixes

* npm publish failure ([#288](https://github.com/snaha/swarm-id/issues/288)) ([f77bb54](https://github.com/snaha/swarm-id/commit/f77bb542e6265f6e1a39fd09737d44c021df8473))

## [0.1.0](https://github.com/snaha/swarm-id/compare/v0.0.1...v0.1.0) (2026-03-31)


### ⚠ BREAKING CHANGES

* Replace `swarmEncryptionKey` with generic `derivationKey` on all account types. The derivation key is persisted in the account and used to deterministically derive sub-keys without re-authentication:

### Features

* ACT ([#158](https://github.com/snaha/swarm-id/issues/158)) ([a3372f9](https://github.com/snaha/swarm-id/commit/a3372f9a86ae3f772c94619c758e42230cc5869d))
* add tryCreateTag utility for gateway compatibility ([#261](https://github.com/snaha/swarm-id/issues/261)) ([f0f9373](https://github.com/snaha/swarm-id/commit/f0f9373629d929cf35b4b8c6d159902e2ff3f4a7))
* agent account ([#186](https://github.com/snaha/swarm-id/issues/186)) ([d3627c1](https://github.com/snaha/swarm-id/commit/d3627c1f3d9c1e49ebb820ba116c21298d4e242d))
* API getPostageBatch function ([#163](https://github.com/snaha/swarm-id/issues/163)) ([b4eacaa](https://github.com/snaha/swarm-id/commit/b4eacaa1f5ed618353559d0ad3e2b3223b9ea3cf))
* app metadata ([#71](https://github.com/snaha/swarm-id/issues/71)) ([e4fea7c](https://github.com/snaha/swarm-id/commit/e4fea7cf963a4c8d84d87d4858434c48e8c3ccb2))
* apps tab ([#94](https://github.com/snaha/swarm-id/issues/94)) ([cec242c](https://github.com/snaha/swarm-id/commit/cec242c438ff5dd1a9d9834fa08d8d3c5dbec097))
* connect function ([#130](https://github.com/snaha/swarm-id/issues/130)) ([6c65d6d](https://github.com/snaha/swarm-id/commit/6c65d6df62c930525d645216ef14dd20004e3479))
* connection info ([#123](https://github.com/snaha/swarm-id/issues/123)) ([d0730d0](https://github.com/snaha/swarm-id/commit/d0730d0d0c9722a7f16a2854cbed6d8d282cdaa6))
* encrypted file upload ([#196](https://github.com/snaha/swarm-id/issues/196)) ([d72b8b9](https://github.com/snaha/swarm-id/commit/d72b8b955b2e388068c5d7ec409c034b1e02f454))
* encryption by default ([fde4057](https://github.com/snaha/swarm-id/commit/fde4057ed20382c085f6799fa8d6d0ceb05f1736))
* epoch feeds sync ([#98](https://github.com/snaha/swarm-id/issues/98)) ([18217c9](https://github.com/snaha/swarm-id/commit/18217c9608c49f2753a2b08799d550736b3d1c35))
* feed api ([#172](https://github.com/snaha/swarm-id/issues/172)) ([4d5bc92](https://github.com/snaha/swarm-id/commit/4d5bc92d72a5f35502d29d85357957bbb4cb8d77))
* initial version of swarm identity UI with deployment to DO ([#1](https://github.com/snaha/swarm-id/issues/1)) ([b826b86](https://github.com/snaha/swarm-id/commit/b826b8664adcb9a3cd01a16aad42f04e63554774))
* lib ([7be8256](https://github.com/snaha/swarm-id/commit/7be8256eedb4af202c73a689fd49f881d949c123))
* network settings ([#125](https://github.com/snaha/swarm-id/issues/125)) ([599b1cf](https://github.com/snaha/swarm-id/commit/599b1cf53d057225cf73dd9f3c1361c1bfb2f06b))
* postage stamp in swarm-id page ([968bdc6](https://github.com/snaha/swarm-id/commit/968bdc6df9d4a6df9258419b37abd63238895ed7))
* postage stamp utilization on swarm ([#111](https://github.com/snaha/swarm-id/issues/111)) ([e28319c](https://github.com/snaha/swarm-id/commit/e28319c516eaff47fb28ce23d7b4ba2ed27d576b))
* postage stamps ([#97](https://github.com/snaha/swarm-id/issues/97)) ([68c8e86](https://github.com/snaha/swarm-id/commit/68c8e864f996666c6ca4e05f21147e019b1a4087))
* proxy uses postage stamp ([#119](https://github.com/snaha/swarm-id/issues/119)) ([3fac6c9](https://github.com/snaha/swarm-id/commit/3fac6c95a1f539139ef4fbf38c8bb45756d645fd))
* rename lib to @snaha/swarm-id and add automated npm publishing ([#249](https://github.com/snaha/swarm-id/issues/249)) ([6f78459](https://github.com/snaha/swarm-id/commit/6f78459e5e7d691165adaa994803d173b281a9c9))
* safari consume only mode ([#227](https://github.com/snaha/swarm-id/issues/227)) ([751d0b9](https://github.com/snaha/swarm-id/commit/751d0b9e57f5345b7378b2d8486d292ca84fb5ad))
* show warning how to make the demo work on safari ([#180](https://github.com/snaha/swarm-id/issues/180)) ([39673c3](https://github.com/snaha/swarm-id/commit/39673c324a04bef2db6a1d051d9b9f8ae610d3fa))
* sign in and import/export flow ([#198](https://github.com/snaha/swarm-id/issues/198)) ([e0b324a](https://github.com/snaha/swarm-id/commit/e0b324abebfdbb5e8b104e75bcad870f4107f00d))
* simplified local development ([#138](https://github.com/snaha/swarm-id/issues/138)) ([96e308d](https://github.com/snaha/swarm-id/commit/96e308d6b2bee56ea51c7ac82b7eeae67babe68d))
* SOC API ([#165](https://github.com/snaha/swarm-id/issues/165)) ([40d1d6d](https://github.com/snaha/swarm-id/commit/40d1d6d54687ccb99d03eeb4b696672c81db3d1a))
* store derivation key in account for deterministic key derivation ([#254](https://github.com/snaha/swarm-id/issues/254)) ([9430bf1](https://github.com/snaha/swarm-id/commit/9430bf10bbc050ad7fa8de453e92b9b2cf0c909f)), closes [#222](https://github.com/snaha/swarm-id/issues/222)
* store deviceId for multi-device support ([#228](https://github.com/snaha/swarm-id/issues/228)) ([#251](https://github.com/snaha/swarm-id/issues/251)) ([856e671](https://github.com/snaha/swarm-id/commit/856e671cc15bd4dc6fc6169659969e02cfacb25f))
* tab coordination ([#210](https://github.com/snaha/swarm-id/issues/210)) ([bc33d09](https://github.com/snaha/swarm-id/commit/bc33d0972a54833aeb013a7b7ba007403bb2a0ab))
* upload with chunking ([1338989](https://github.com/snaha/swarm-id/commit/133898996201d5431d949261334b70feb590a35b))
* use hash params instead of options ([#103](https://github.com/snaha/swarm-id/issues/103)) ([a7feda2](https://github.com/snaha/swarm-id/commit/a7feda2ac8c956671beae199d2de552165957cea))
* view ethereum generation details ([#126](https://github.com/snaha/swarm-id/issues/126)) ([11a33dc](https://github.com/snaha/swarm-id/commit/11a33dc1604ef3272909ca980da75ef2c3681d2f))
* websocket upload ([#252](https://github.com/snaha/swarm-id/issues/252)) ([34d090f](https://github.com/snaha/swarm-id/commit/34d090fa774f33292a514b9732efb8271b64eb12))


### Bug Fixes

* add init error message ([d0cf9bf](https://github.com/snaha/swarm-id/commit/d0cf9bf29311c643fecc5163ae21918627e36955))
* add init error message ([a77ee0f](https://github.com/snaha/swarm-id/commit/a77ee0fbcfdb0f53699170c65410820a2ea8a1d4))
* API improvements ([#147](https://github.com/snaha/swarm-id/issues/147)) ([086c215](https://github.com/snaha/swarm-id/commit/086c215d930678de3e6b1373ff85dda2f9e35c83))
* API improvements, second round ([#148](https://github.com/snaha/swarm-id/issues/148)) ([f4af1d0](https://github.com/snaha/swarm-id/commit/f4af1d0b0b3037582add13a77becc85e26e14cc6))
* app to properly disconnect when the disconnect button is pressed ([#203](https://github.com/snaha/swarm-id/issues/203)) ([8cd26df](https://github.com/snaha/swarm-id/commit/8cd26df1b6aaa35d95a466c9278f8324b42143c5))
* connect correct identity if multiple identities available for the app ([#182](https://github.com/snaha/swarm-id/issues/182)) ([0afa763](https://github.com/snaha/swarm-id/commit/0afa763d39793f716a2dc9f1111f60af0409df00))
* demo fixes ([#137](https://github.com/snaha/swarm-id/issues/137)) ([31c751c](https://github.com/snaha/swarm-id/commit/31c751cb6daf30f9a74564a4793c45cbd4d07f16))
* digitalocean deployment error ([#23](https://github.com/snaha/swarm-id/issues/23)) ([74c4df5](https://github.com/snaha/swarm-id/commit/74c4df58629c9a466348780ebc364dc8f2de5b32))
* disconnect button ([#70](https://github.com/snaha/swarm-id/issues/70)) ([4a9e3aa](https://github.com/snaha/swarm-id/commit/4a9e3aa089bcef04ad706e8622e343ed3e34494d)), closes [#37](https://github.com/snaha/swarm-id/issues/37)
* encryption ([f10ee08](https://github.com/snaha/swarm-id/commit/f10ee08a2e19174749c56722b2ee08177920a98f))
* feed API inconsistencies ([#197](https://github.com/snaha/swarm-id/issues/197)) ([21e89a6](https://github.com/snaha/swarm-id/commit/21e89a684cd0208cb8773c4924d83e45de6841c6))
* gsocSend use stamper ([#212](https://github.com/snaha/swarm-id/issues/212)) ([756362a](https://github.com/snaha/swarm-id/commit/756362aeba3d7f3308fb59a10fa7fb02290efb09)), closes [#211](https://github.com/snaha/swarm-id/issues/211)
* iframe init race condition ([#39](https://github.com/snaha/swarm-id/issues/39)) ([b06024c](https://github.com/snaha/swarm-id/commit/b06024c9ae541158b11b41a8e3c9cfb1af698f2f)), closes [#38](https://github.com/snaha/swarm-id/issues/38)
* implement file and chunk upload/download ([2de6ca8](https://github.com/snaha/swarm-id/commit/2de6ca88d53e9def17b055dd6911a95e74a08914))
* ios connection in mobile safari ([#178](https://github.com/snaha/swarm-id/issues/178)) ([50a4144](https://github.com/snaha/swarm-id/commit/50a414491545d63a664c669a5a515368d9c9cc40))
* local dev server demo app route ([#28](https://github.com/snaha/swarm-id/issues/28)) ([4a15a14](https://github.com/snaha/swarm-id/commit/4a15a1470983d47577e8f753c7b1375f657dac2d))
* open auth window directly on Chrome/Firefox to avoid popup blocking ([#255](https://github.com/snaha/swarm-id/issues/255)) ([#256](https://github.com/snaha/swarm-id/issues/256)) ([89880f5](https://github.com/snaha/swarm-id/commit/89880f542aff0c7d88b5cdc748c280490fa40da4))
* race condition in demo ([#15](https://github.com/snaha/swarm-id/issues/15)) ([e69e572](https://github.com/snaha/swarm-id/commit/e69e5727186d0f38809295bab54b70ea9b35de12))
* refactor store ([#151](https://github.com/snaha/swarm-id/issues/151)) ([4d6cc72](https://github.com/snaha/swarm-id/commit/4d6cc72ac40732ec3f1e4477b3486658bf0975b3))
* remove async ([b9733d0](https://github.com/snaha/swarm-id/commit/b9733d0298259f1639b33635c69c7b6f1d817a85))
* remove requirement for postage stamp or signer key when connecting app ([#108](https://github.com/snaha/swarm-id/issues/108)) ([ed159ba](https://github.com/snaha/swarm-id/commit/ed159ba3f360068348f4d278608d4ac610b158e0))
* remove semicolons ([e04be17](https://github.com/snaha/swarm-id/commit/e04be174e87c76021f501d3eb335e48ee31620af))
* swarm-id integration issues ([#285](https://github.com/snaha/swarm-id/issues/285)) ([7525a35](https://github.com/snaha/swarm-id/commit/7525a35c82af8cbf87bb06da88f501c3496bb15f)), closes [#284](https://github.com/snaha/swarm-id/issues/284)
* type errors ([cd87dc8](https://github.com/snaha/swarm-id/commit/cd87dc874bc450cffaa7bb3e668602df3102fcdd))
* typescript 5.9 compile issues (reverted to 5.8) ([c1eb1d3](https://github.com/snaha/swarm-id/commit/c1eb1d3ecc3cdd76841a564c930d482738c65980))
* upload and download ([4bd5b5c](https://github.com/snaha/swarm-id/commit/4bd5b5c8ff149cc87eefb3a3258fd8b3cb721dfa))
* use bigint amount in postage batch data ([#224](https://github.com/snaha/swarm-id/issues/224)) ([05fab16](https://github.com/snaha/swarm-id/commit/05fab16c4c600fd00237b518cb9678f21e6a959b))


### Miscellaneous Chores

* release 0.1.0 ([#267](https://github.com/snaha/swarm-id/issues/267)) ([456ceb0](https://github.com/snaha/swarm-id/commit/456ceb0ce2ecf6fdba455d6acb0bd5a9396f8073))
