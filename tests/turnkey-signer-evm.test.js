import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { HDNodeWallet, Transaction, verifyAuthorization, verifyMessage, verifyTypedData } from 'ethers'
import { ISigner } from '@tetherto/wdk-wallet'
import WalletManagerEvm, { WalletAccountEvm } from '@tetherto/wdk-wallet-evm'
import { TurnkeySignerEvm } from '../index.js'
import { FakeTurnkeyClient } from './fake-turnkey-client.js'

// the usual hardhat test mnemonic
const MNEMONIC = 'test test test test test test test test test test test junk'
const WALLET_ID = 'wallet-1'
const root = HDNodeWallet.fromPhrase(MNEMONIC, undefined, 'm')
const local = (rel) => root.derivePath(`44'/60'/${rel}`)

const TX = { chainId: 1, nonce: 7, to: '0x000000000000000000000000000000000000dEaD', value: 1000n, data: '0x', type: 2, gasLimit: 21000n, maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }
const TYPED = {
  domain: { name: 'WDK', version: '1', chainId: 1, verifyingContract: '0x000000000000000000000000000000000000dEaD' },
  types: { Transfer: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  message: { to: '0x000000000000000000000000000000000000dEaD', amount: 42 }
}

describe('TurnkeySignerEvm', () => {
  let client, signer
  before(() => { client = new FakeTurnkeyClient(MNEMONIC); signer = new TurnkeySignerEvm({ client, walletId: WALLET_ID }) })

  it('extends the base ISigner and fulfils the ISignerEvm shape', () => {
    assert.ok(signer instanceof ISigner)
    for (const m of ['derive', 'getAddress', 'sign', 'signTransaction', 'signTypedData', 'signAuthorization', 'dispose']) {
      assert.equal(typeof signer[m], 'function', m)
    }
    for (const g of ['isDerivable', 'index', 'path', 'address', 'keyPair']) {
      assert.ok(g in signer, g)
    }
  })

  it('requires a client and a wallet id', () => {
    assert.throws(() => new TurnkeySignerEvm({ walletId: WALLET_ID }), /client/)
    assert.throws(() => new TurnkeySignerEvm({ client }), /wallet id/)
  })

  it('is a derivable root at 44\'/60\'/0\'/0/0 with no address until resolved', () => {
    assert.equal(signer.isDerivable, true)
    assert.equal(signer.path, "44'/60'/0'/0/0")
    assert.equal(signer.index, 0)
    assert.equal(signer.address, undefined)
    assert.deepEqual(signer.keyPair, { privateKey: null, publicKey: null })
  })

  it('creates the Turnkey wallet account on first getAddress, then reuses it', async () => {
    const address = await signer.getAddress()
    assert.equal(address, local("0'/0/0").address)
    assert.deepEqual(client.calls, ['getWalletAccounts', 'createWalletAccounts', 'getWalletAccounts'])
    assert.equal(signer.address, address)
    assert.equal(await signer.getAddress(), address)
    assert.deepEqual(client.calls, ['getWalletAccounts', 'createWalletAccounts', 'getWalletAccounts'])
    // A second signer on the same path finds the existing account.
    const again = new TurnkeySignerEvm({ client, walletId: WALLET_ID })
    assert.equal(await again.getAddress(), address)
    assert.equal(client.calls.filter(c => c === 'createWalletAccounts').length, 1)
  })

  it('exposes the public key reported by Turnkey, never a private key', async () => {
    await signer.getAddress()
    assert.equal(signer.keyPair.privateKey, null)
    assert.equal(Buffer.from(signer.keyPair.publicKey).toString('hex'), local("0'/0/0").publicKey.slice(2))
  })

  it('signs an EIP-191 message through signRawPayload', async () => {
    const sig = await signer.sign('hello wdk')
    assert.equal(verifyMessage('hello wdk', sig), await signer.getAddress())
    assert.equal(client.calls.at(-1), 'signRawPayload:PAYLOAD_ENCODING_HEXADECIMAL')
  })

  it('signs a transaction through Turnkey signTransaction and returns the signed RLP', async () => {
    const from = await signer.getAddress()
    const signed = await signer.signTransaction({ from, ...TX })
    assert.equal(client.calls.at(-1), 'signTransaction')
    const tx = Transaction.from(signed)
    assert.equal(tx.from, from)
    assert.equal(tx.nonce, 7)
    assert.equal(tx.to, TX.to)
    assert.equal(tx.value, 1000n)
    assert.equal(tx.type, 2)
  })

  it('rejects a transaction whose from is another address', async () => {
    await assert.rejects(signer.signTransaction({ from: local("0'/0/5").address, ...TX }), /does not match/)
  })

  it('signs EIP-712 typed data with the serialized payload encoding', async () => {
    const sig = await signer.signTypedData(TYPED)
    assert.equal(client.calls.at(-1), 'signRawPayload:PAYLOAD_ENCODING_EIP712')
    assert.equal(verifyTypedData(TYPED.domain, TYPED.types, TYPED.message, sig), await signer.getAddress())
  })

  it('signs an EIP-7702 authorization', async () => {
    const auth = await signer.signAuthorization({ address: TX.to, nonce: 3, chainId: 1 })
    assert.equal(auth.address, TX.to)
    assert.equal(auth.nonce, 3n)
    assert.equal(auth.chainId, 1n)
    assert.equal(verifyAuthorization(auth, auth.signature), await signer.getAddress())
  })

  it('derives child signers that resolve their own account and cannot derive further', async () => {
    const child = await signer.derive("0'/0/3")
    assert.equal(child.isDerivable, false)
    assert.equal(child.index, 3)
    assert.equal(await child.getAddress(), local("0'/0/3").address)
    await assert.rejects(child.derive("0'/0/4"), /Cannot derive/)
  })

  it('refuses to work after dispose', async () => {
    const s = new TurnkeySignerEvm({ client, walletId: WALLET_ID, path: "0'/0/9" })
    s.dispose()
    await assert.rejects(s.getAddress(), /disposed/)
  })
})

describe('TurnkeySignerEvm inside wdk-wallet-evm', () => {
  let client
  before(() => { client = new FakeTurnkeyClient(MNEMONIC) })

  it('backs a WalletManagerEvm as the default signer', async () => {
    const manager = new WalletManagerEvm(new TurnkeySignerEvm({ client, walletId: WALLET_ID }))
    const account = await manager.getAccount(2)
    assert.ok(account instanceof WalletAccountEvm)
    assert.equal(await account.getAddress(), local("0'/0/2").address)
    assert.equal(account.path, "44'/60'/0'/0/2")
    const sig = await account.sign('from the manager')
    assert.equal(verifyMessage('from the manager', sig), local("0'/0/2").address)
    const byPath = await manager.getAccountByPath("0'/1/0")
    assert.equal(await byPath.getAddress(), local("0'/1/0").address)
    manager.dispose()
  })

  it('is accepted by addSigner and resolved with getAccount(signerName)', async () => {
    const seedManager = new WalletManagerEvm(MNEMONIC)
    seedManager.addSigner('turnkey', new TurnkeySignerEvm({ client, walletId: WALLET_ID, path: "0'/0/7" }))
    const account = await seedManager.getAccount('turnkey')
    assert.equal(await account.getAddress(), local("0'/0/7").address)
    const signed = await account.signTransaction(TX)
    assert.equal(Transaction.from(signed).from, local("0'/0/7").address)
    seedManager.dispose()
  })

  it('backs a standalone WalletAccountEvm, including typed data and 7702', async () => {
    const account = new WalletAccountEvm(new TurnkeySignerEvm({ client, walletId: WALLET_ID, path: "0'/0/1", isChild: true }))
    const address = await account.getAddress()
    assert.equal(address, local("0'/0/1").address)
    const sig = await account.signTypedData(TYPED)
    assert.equal(verifyTypedData(TYPED.domain, TYPED.types, TYPED.message, sig), address)
    const auth = await account.signAuthorization({ address: TX.to, nonce: 0, chainId: 1 })
    assert.equal(verifyAuthorization(auth, auth.signature), address)
    assert.equal(account.keyPair.privateKey, null)
    account.dispose()
  })
})
