import { Bee, MerkleTree, PrivateKey, Stamper } from '@ethersphere/bee-js'
const BATCH = 'd5c0b61d95da62d95568256480cf75b6f38fb215409281ccf474ee85b22345e2'
const KEY = 'c503008cd9ae755caa99cee821c0c1d4169554b93526328dcd01b8e047573d1b'
const bee = new Bee('http://localhost:1633')
const stamper = Stamper.fromBlank(new PrivateKey(KEY), BATCH, 17)

const payload = new TextEncoder().encode('bought on Gnosis, stored on Swarm')
const chunk = await MerkleTree.root(payload)
const envelope = stamper.stamp(chunk)
const result = await bee.uploadChunk(envelope, chunk.build(), { deferred: true })
console.log('UPLOADED', result.reference.toHex())
const back = await bee.downloadChunk(result.reference.toHex())
console.log('DOWNLOADED:', new TextDecoder().decode(back.toUint8Array().slice(8)))
