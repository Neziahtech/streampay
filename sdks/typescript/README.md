# @streampay/sdk

Typed TypeScript client for the StreamPay Soroban contract, generated from
[`sdks/spec/streampay.spec.json`](../spec/streampay.spec.json).

```bash
npm install @streampay/sdk @stellar/stellar-sdk
```

Requires Node 20+.

## Quickstart against testnet

```ts
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { StreamPayClient, signerFromKeypair } from "@streampay/sdk";

const keypair = Keypair.fromSecret(process.env.STELLAR_SECRET!);

const client = new StreamPayClient({
  contractId: process.env.STREAM_CONTRACT_ID!,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: signerFromKeypair(keypair),
});

// Reads need no signer and no wallet:
const stream = await client.getStream(1);
console.log(stream.deposit, stream.status, stream.startTime);

// Mutating calls: build -> simulate -> sign -> send -> poll -> decode
const id = await client.createStream({
  sender: keypair.publicKey(),
  recipient: "G…recipient",
  token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // testnet native SAC
  depositAmount: 10_000_000n,
  startTime: Math.floor(Date.now() / 1000) + 1,
  endTime: Math.floor(Date.now() / 1000) + 3600,
  cancelable: true,
});

const paid = await client.withdrawMax({ streamId: id });
```

For a browser wallet, pass any object implementing `Signer`:

```ts
import { signTransaction } from "@stellar/freighter-api";
import type { Signer } from "@streampay/sdk";

const freighter: Signer = {
  publicKey: () => address, // from freighter requestAccess()
  async signTransaction(xdr, { networkPassphrase }) {
    const { signedTxXdr } = await signTransaction(xdr, { networkPassphrase });
    return { signedTxXdr };
  },
};
```

The pipeline mirrors `frontend/lib/stellar.ts`: simulate first (early typed
contract errors), assemble, sign, submit, poll, then decode the return value.

## Events

Events from RPC (`getEvents`) are base64 `ContractEvent` XDR:

```ts
import { decodeEvents } from "@streampay/sdk";

const events = decodeEvents(rpcResponse.events.map((event) => event.valueXdr));
// StreamCreatedEvent | WithdrawnEvent | StreamCancelledEvent | StreamToppedUpEvent
for (const event of events) {
  if (event.type === "StreamCreated") {
    console.log(event.streamId, event.deposit, event.sender);
  }
}
```

Malformed XDR throws; events from other contracts are not returned.

## Index pagination

```ts
const ids = await client.streamIds("recipient", address);
const streams = await client.streamsFor("recipient", address);
```

`streamIds` follows the on-chain `recipient_streams` / `sender_streams` pages
until exhausted, clamping the page size to `MAX_PAGE_SIZE`. `streamsFor` skips
ids that no longer resolve.

## Errors

`StreamPayError` carries the failing stage:

```ts
import { StreamPayError } from "@streampay/sdk";

try {
  await client.withdraw({ streamId: 1, amount: 1n });
} catch (error) {
  if (error instanceof StreamPayError) {
    console.log(error.kind);      // simulation | submission | inclusion | decode | transport
    console.log(error.contract);  // { code: 10, name: "AmountExceedsAvailable" }
    console.log(error.transactionXdr);
  }
}
```

## Conformance

`npm test` runs the vector suite plus pagination, event, and error tests.
`npm run conformance -- ../vectors` prints this SDK's canonical decode for the
cross-language runner.

## Versioning and publishing

Lockstep with the other SDKs; see [`../README.md`](../README.md#versioning-policy).
`npm publish --dry-run` runs in CI; `sdk-v*` tags publish with `NPM_TOKEN` and
provenance enabled.
