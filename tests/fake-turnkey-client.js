// Stands in for Turnkey's apiClient(), signing with a local HD wallet. Field names follow @turnkey/sdk-types 8.x.
import { HDNodeWallet, Signature, Transaction, TypedDataEncoder } from 'ethers'

export class FakeTurnkeyClient {
  constructor (mnemonic) {
    this.root = HDNodeWallet.fromPhrase(mnemonic, undefined, 'm')
    this.accounts = []
    this.calls = []
  }

  _wallet (address) {
    const a = this.accounts.find(x => x.address.toLowerCase() === address.toLowerCase())
    if (!a) throw new Error(`Turnkey: unknown signWith ${address}`)
    return this.root.derivePath(a.path.slice(2))
  }

  async getWalletAccounts ({ walletId }) {
    this.calls.push('getWalletAccounts')
    return { accounts: this.accounts.filter(a => a.walletId === walletId) }
  }

  async createWalletAccounts ({ walletId, accounts }) {
    this.calls.push('createWalletAccounts')
    const addresses = []
    for (const spec of accounts) {
      if (spec.curve !== 'CURVE_SECP256K1' || spec.pathFormat !== 'PATH_FORMAT_BIP32' || spec.addressFormat !== 'ADDRESS_FORMAT_ETHEREUM') {
        throw new Error('Turnkey: unsupported account spec ' + JSON.stringify(spec))
      }
      const w = this.root.derivePath(spec.path.slice(2))
      this.accounts.push({ walletId, path: spec.path, curve: spec.curve, addressFormat: spec.addressFormat, address: w.address, publicKey: w.publicKey.slice(2) })
      addresses.push(w.address)
    }
    return { addresses }
  }

  async signRawPayload ({ signWith, payload, encoding, hashFunction }) {
    this.calls.push('signRawPayload:' + encoding)
    if (hashFunction !== 'HASH_FUNCTION_NO_OP') throw new Error('Turnkey: fake only supports HASH_FUNCTION_NO_OP')
    const w = this._wallet(signWith)
    let digest
    if (encoding === 'PAYLOAD_ENCODING_HEXADECIMAL') {
      if (payload.startsWith('0x')) throw new Error('Turnkey: payload must not carry a 0x prefix')
      digest = '0x' + payload
    } else if (encoding === 'PAYLOAD_ENCODING_EIP712') {
      const { domain, types, message } = JSON.parse(payload)
      const { EIP712Domain, ...rest } = types
      digest = TypedDataEncoder.hash(domain, rest, message)
    } else {
      throw new Error('Turnkey: unsupported encoding ' + encoding)
    }
    const sig = w.signingKey.sign(digest)
    return { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.yParity === 0 ? '00' : '01' }
  }

  async signTransaction ({ signWith, unsignedTransaction, type }) {
    this.calls.push('signTransaction')
    if (type !== 'TRANSACTION_TYPE_ETHEREUM') throw new Error('Turnkey: unsupported type ' + type)
    if (unsignedTransaction.startsWith('0x')) throw new Error('Turnkey: unsignedTransaction must not carry a 0x prefix')
    const w = this._wallet(signWith)
    const tx = Transaction.from('0x' + unsignedTransaction)
    tx.signature = Signature.from(w.signingKey.sign(tx.unsignedHash))
    return { signedTransaction: tx.serialized.slice(2) }
  }
}
