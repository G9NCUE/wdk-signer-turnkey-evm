'use strict'

import { ISigner, InvalidSignerError, ValueError } from '@tetherto/wdk-wallet'
import { Signature, Transaction, TypedDataEncoder, getBytes, hashAuthorization, hashMessage } from 'ethers'

const PATH_PREFIX = "44'/60'"
const DEFAULT_PATH = "0'/0/0"

// Follows the ISignerEvm contract by shape: wdk-wallet-evm beta.18 does not export the class.
export default class TurnkeySignerEvm extends ISigner {
  // client is `new Turnkey(config).apiClient()` from @turnkey/sdk-server
  constructor ({ client, walletId, path = DEFAULT_PATH, isChild = false } = {}) {
    super()
    if (!client) throw new ValueError('A Turnkey API client is required.')
    if (!walletId) throw new ValueError('A Turnkey wallet id is required.')
    this._client = client
    this._walletId = walletId
    this._path = `${PATH_PREFIX}/${path}`
    this._isChild = isChild
    this._address = undefined
    this._publicKey = null
  }

  static async connect (opts) {
    const signer = new TurnkeySignerEvm(opts)
    await signer.getAddress()
    return signer
  }

  get isDerivable () { return !this._isChild }
  get index () { return +this._path.split('/').pop() }
  get path () { return this._path }
  get address () { return this._address }
  get keyPair () { return { privateKey: null, publicKey: this._publicKey } }

  async derive (relPath) {
    if (!this.isDerivable) throw new InvalidSignerError('Cannot derive: this signer is a derived child.')
    return new TurnkeySignerEvm({ client: this._client, walletId: this._walletId, path: relPath, isChild: true })
  }

  async getAddress () {
    if (this._address) return this._address
    if (!this._client) throw new InvalidSignerError('The signer has been disposed.')

    const path = `m/${this._path}`
    let account = await this._findAccount(path)
    if (!account) {
      const { addresses } = await this._client.createWalletAccounts({
        walletId: this._walletId,
        accounts: [{ curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path, addressFormat: 'ADDRESS_FORMAT_ETHEREUM' }]
      })
      // createWalletAccounts only returns addresses, list again for the public key
      account = (await this._findAccount(path)) || { address: addresses[0] }
    }
    this._address = account.address
    this._publicKey = account.publicKey ? getBytes(hex0x(account.publicKey)) : null
    return this._address
  }

  async sign (message) {
    return (await this._signRaw(hashMessage(message).slice(2), 'PAYLOAD_ENCODING_HEXADECIMAL')).serialized
  }

  async signTransaction (unsignedTx) {
    const address = await this.getAddress()
    const { from, ...txLike } = unsignedTx
    if (from && from.toLowerCase() !== address.toLowerCase()) {
      throw new ValueError(`Transaction "from" (${from}) does not match the signer address (${address}).`)
    }
    const { signedTransaction } = await this._client.signTransaction({
      signWith: address,
      unsignedTransaction: Transaction.from(txLike).unsignedSerialized.slice(2),
      type: 'TRANSACTION_TYPE_ETHEREUM'
    })
    return hex0x(signedTransaction)
  }

  // sent unhashed so Turnkey policies can read the fields
  async signTypedData ({ domain, types, message }) {
    const payload = TypedDataEncoder.getPayload(domain, types, message)
    return (await this._signRaw(JSON.stringify(payload), 'PAYLOAD_ENCODING_EIP712')).serialized
  }

  async signAuthorization (auth) {
    const populated = { address: auth.address, nonce: BigInt(auth.nonce ?? 0), chainId: BigInt(auth.chainId ?? 0) }
    const signature = await this._signRaw(hashAuthorization(populated).slice(2), 'PAYLOAD_ENCODING_HEXADECIMAL')
    return { ...populated, signature }
  }

  dispose () {
    this._client = undefined
    this._publicKey = null
  }

  async _findAccount (path) {
    const { accounts } = await this._client.getWalletAccounts({ walletId: this._walletId, paginationOptions: { limit: '100' } })
    return accounts.find(a => a.path === path && a.addressFormat === 'ADDRESS_FORMAT_ETHEREUM')
  }

  async _signRaw (payload, encoding) {
    const { r, s, v } = await this._client.signRawPayload({
      signWith: await this.getAddress(),
      payload,
      encoding,
      hashFunction: 'HASH_FUNCTION_NO_OP'
    })
    // Turnkey gives v as the recovery id, 00 or 01, ethers wants 27 or 28
    return Signature.from({ r: hex0x(r), s: hex0x(s), v: 27 + parseInt(v, 16) })
  }
}

function hex0x (hex) {
  return hex.startsWith('0x') ? hex : `0x${hex}`
}
