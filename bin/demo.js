#!/usr/bin/env node
// Sepolia demo: Turnkey wallet, WDK account, transfer signed by Turnkey, confirmation.
// Usage: wdk-turnkey-demo [--fresh-wallet] [--to 0x...] [--amount 0.0001] [--dry-run]
import { parseArgs } from 'node:util'
import { Turnkey } from '@turnkey/sdk-server'
import { Transaction, formatEther, parseEther, verifyMessage } from 'ethers'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { TurnkeySignerEvm } from '../index.js'

const { values: opts } = parseArgs({ options: {
  'fresh-wallet': { type: 'boolean', default: false },
  to: { type: 'string' },
  amount: { type: 'string', default: process.env.DEMO_AMOUNT_ETH || '0.0001' },
  'dry-run': { type: 'boolean', default: false }
} })

const env = (k, fallback) => process.env[k] ?? fallback ?? (() => { throw new Error(`${k} is not set, see .env.example`) })()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let n = 0
const step = (title) => console.log(`\n${++n}. ${title}`)
const out = (k, v) => console.log(`   ${k.padEnd(14)} ${v}`)

const client = new Turnkey({
  apiBaseUrl: env('TURNKEY_BASE_URL', 'https://api.turnkey.com'),
  apiPublicKey: env('TURNKEY_API_PUBLIC_KEY'),
  apiPrivateKey: env('TURNKEY_API_PRIVATE_KEY'),
  defaultOrganizationId: env('TURNKEY_ORGANIZATION_ID')
}).apiClient()

console.log('WDK wallet on Sepolia, signing with Turnkey.')

step('Turnkey wallet')
let walletId = opts['fresh-wallet'] ? undefined : process.env.TURNKEY_WALLET_ID
if (walletId) {
  out('wallet', `${walletId} (from TURNKEY_WALLET_ID)`)
} else {
  ({ walletId } = await client.createWallet({ walletName: `wdk-demo-${new Date().toISOString().slice(0, 16)}`, accounts: [] }))
  out('wallet', `${walletId} (created, no accounts yet)`)
}

step('WDK wallet manager backed by TurnkeySignerEvm')
const wallet = new WalletManagerEvm(new TurnkeySignerEvm({ client, walletId }), {
  provider: env('SEPOLIA_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com')
})
const account = await wallet.getAccount(0)
const address = await account.getAddress()
out('account', `index ${account.index}, path ${account.path}`)
out('address', address)
out('privateKey', String(account.keyPair.privateKey))

step('Message signature through Turnkey')
const sig = await account.sign('hello from wdk')
out('signature', sig.slice(0, 22) + '…')
out('recovers to', verifyMessage('hello from wdk', sig) === address ? 'the account address' : 'MISMATCH')

step('Balance')
let balance = await account.getBalance()
while (balance === 0n) {
  out('balance', `0 ETH. Fund ${address} from a Sepolia faucet, checking every 15s`)
  await sleep(15000)
  balance = await account.getBalance()
}
out('balance', `${formatEther(balance)} ETH`)

step(`Send ${opts.amount} ETH`)
const tx = { to: opts.to || address, value: parseEther(opts.amount) }
out('to', tx.to === address ? `${tx.to} (self)` : tx.to)
const { fee } = await account.quoteSendTransaction(tx)
out('quoted fee', `${formatEther(fee)} ETH`)
if (opts['dry-run']) {
  const signed = await account.signTransaction({ ...tx, chainId: 11155111, nonce: 0, type: 2, gasLimit: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, data: '0x' })
  out('signed by', Transaction.from(signed).from === address ? 'Turnkey, not broadcast (--dry-run)' : 'MISMATCH')
  wallet.dispose()
  process.exit(0)
}
const { hash } = await account.sendTransaction(tx)
out('broadcast', `https://sepolia.etherscan.io/tx/${hash}`)

step('Confirmation')
const receipt = await account.waitForTransaction(hash, { target: 'confirmed', timeout: 300000 })
out('status', receipt.success ? 'success' : 'REVERTED')
out('block', receipt.block)
out('fee paid', `${formatEther(receipt.fee ?? 0n)} ETH`)
out('balance', `${formatEther(await account.getBalance())} ETH`)

console.log(`\nDone. Turnkey wallet ${walletId}, account ${address}, tx ${hash}`)
wallet.dispose()
