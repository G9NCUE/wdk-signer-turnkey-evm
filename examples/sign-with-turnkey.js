// Runs each ISignerEvm operation against a real Turnkey wallet. Nothing is broadcast.
// Run: node --env-file=.env examples/sign-with-turnkey.js
import { Turnkey } from '@turnkey/sdk-server'
import { Transaction, verifyAuthorization, verifyMessage, verifyTypedData } from 'ethers'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { TurnkeySignerEvm } from '../index.js'

const env = (k, fallback) => process.env[k] ?? fallback ?? (() => { throw new Error(`${k} is not set`) })()

const client = new Turnkey({
  apiBaseUrl: env('TURNKEY_BASE_URL', 'https://api.turnkey.com'),
  apiPublicKey: env('TURNKEY_API_PUBLIC_KEY'),
  apiPrivateKey: env('TURNKEY_API_PRIVATE_KEY'),
  defaultOrganizationId: env('TURNKEY_ORGANIZATION_ID')
}).apiClient()

const wallet = new WalletManagerEvm(new TurnkeySignerEvm({ client, walletId: env('TURNKEY_WALLET_ID') }))
const account = await wallet.getAccount(0)
const address = await account.getAddress()
console.log('getAddress       ', address, account.path)

const sig = await account.sign('hello from wdk')
console.log('sign             ', verifyMessage('hello from wdk', sig) === address ? 'ok' : 'FAIL')

const signed = await account.signTransaction({
  chainId: 11155111, nonce: 0, to: address, value: 0n, data: '0x', type: 2,
  gasLimit: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n
})
console.log('signTransaction  ', Transaction.from(signed).from === address ? 'ok' : 'FAIL')

const typed = {
  domain: { name: 'WDK', version: '1', chainId: 11155111, verifyingContract: address },
  types: { Transfer: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  message: { to: address, amount: 42 }
}
const typedSig = await account.signTypedData(typed)
console.log('signTypedData    ', verifyTypedData(typed.domain, typed.types, typed.message, typedSig) === address ? 'ok' : 'FAIL')

const auth = await account.signAuthorization({ address, nonce: 1, chainId: 11155111 })
console.log('signAuthorization', verifyAuthorization(auth, auth.signature) === address ? 'ok' : 'FAIL')

const child = await wallet.getAccount(1)
console.log('derive           ', await child.getAddress(), child.path)

wallet.dispose()
