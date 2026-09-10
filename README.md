# wdk-signer-turnkey-evm

A Turnkey signer for the Tether WDK. It implements the `ISignerEvm` contract from
`@tetherto/wdk-wallet-evm`, which means a WDK EVM wallet can sign with keys held by
[Turnkey](https://www.turnkey.com) instead of a local seed. The WDK itself is not modified.

I wrote it to check whether the Universal Signer abstraction actually holds up with a remote
signer, and it does. On 10 September 2026 the demo below created a Turnkey wallet through the API,
derived an account with the WDK, signed a transfer with Turnkey and broadcast it with the WDK:
[0x9b29b168…8bbbb on Sepolia](https://sepolia.etherscan.io/tx/0x9b29b1680378b7e5df7b80904ba4909d8476cbc9365147e07726db7c1ed8bbbb).

## Background

In the WDK, the wallet account decides what to sign and the signer holds the key. The EVM
package ships two signers, one from a seed and one from a raw private key, and a Ledger signer is
being worked on. The pieces fit together like this:

```
WalletManagerEvm -> WalletAccountEvm -> ISignerEvm -> TurnkeySignerEvm -> Turnkey API
   derivation        populate, quote,     contract      this repo,         keys, policies
                     broadcast, wait                    one file
```

## Usage

```js
import { Turnkey } from '@turnkey/sdk-server'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { TurnkeySignerEvm } from 'wdk-signer-turnkey-evm'

const client = new Turnkey({ apiBaseUrl, apiPublicKey, apiPrivateKey, defaultOrganizationId }).apiClient()

const wallet = new WalletManagerEvm(new TurnkeySignerEvm({ client, walletId }), { provider: rpcUrl })
const account = await wallet.getAccount(0)      // Turnkey account at m/44'/60'/0'/0/0, created if it does not exist
await account.sendTransaction({ to, value })    // the WDK builds and broadcasts, Turnkey signs

// a second signer registered by name
wallet.addSigner('treasury', new TurnkeySignerEvm({ client, walletId, path: "0'/0/7", isChild: true }))
await wallet.getAccount('treasury')
```

Paths are relative to `44'/60'`, same convention as `SeedSignerEvm`. `account.keyPair.privateKey`
is always `null`, there is no key on this side.

## What goes to Turnkey

| WDK call | Turnkey call | Checked against the live API |
|---|---|---|
| `getAddress`, `derive` | `getWalletAccounts`, `createWalletAccounts` | yes |
| `signTransaction` | `signTransaction` with the unsigned RLP, `TRANSACTION_TYPE_ETHEREUM` | yes, and broadcast |
| `signTypedData` | `signRawPayload`, `PAYLOAD_ENCODING_EIP712`, typed data sent as is | yes |
| `sign` (EIP-191) | `signRawPayload` on the digest, `HASH_FUNCTION_NO_OP` | yes |
| `signAuthorization` (EIP-7702) | `signRawPayload` on the digest, `HASH_FUNCTION_NO_OP` | yes, signature only |

Transactions and typed data are sent unhashed, so Turnkey policies can look at their fields.
Messages and 7702 authorizations arrive as digests, Turnkey cannot inspect those.

## Running it

```sh
npm install
npm test                                # offline, a fake Turnkey client backed by a local HD wallet
cp .env.example .env && chmod 600 .env  # fill in the organization id and the API key pair
npm run example                         # each signer operation against your Turnkey wallet, nothing broadcast
npm run demo                            # Sepolia: wallet, account, funding, transfer, confirmation
npm run demo -- --fresh-wallet          # start by creating a new Turnkey wallet
npm run demo -- --dry-run               # sign the transfer but do not broadcast it
```

To get the credentials: sign up on https://app.turnkey.com, copy the organization id from the user
menu, then go to "My Profile", "Create an API key" and keep the private key when it is shown. The demo
prints the address to fund and waits for a Sepolia faucet.

## Things I found on the WDK side

- The contract works. All six operations run against Turnkey on an unmodified
  `@tetherto/wdk-wallet-evm` 1.0.0-beta.18.
- beta.18 does not export the `ISignerEvm` class, so this signer extends the base `ISigner` from
  `@tetherto/wdk-wallet` and follows the EVM contract by shape.
  [wdk-wallet-evm#95](https://github.com/tetherto/wdk-wallet-evm/pull/95) adds the export.
- The base `ISigner` is changing in [wdk-wallet#52](https://github.com/tetherto/wdk-wallet/pull/52):
  `isDerivable`, `keyPair`, `path` and `sign` move into it. The class here already has them.
- `wdk-wallet-evm-erc-4337` builds its owner account from a seed and reads the private key directly,
  so it cannot use a remote signer for now. `wdk-wallet-evm-7702-gasless` takes an account and works.
- On the Turnkey side, `createWalletAccounts` returns addresses only. Getting the public key takes a
  second `getWalletAccounts` call.

## Status

A prototype, not on npm. Apache-2.0 like the WDK.
