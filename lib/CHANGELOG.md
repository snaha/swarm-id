# Changelog

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
