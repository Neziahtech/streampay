/**
 * Pure StreamPay operation builders.
 *
 * The UI and the testnet canary both construct contract calls through these
 * functions, so the canary exercises exactly the argument order, types, and
 * units the frontend uses. No wallet, RPC, or React code lives here.
 */
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/** Mirrors the contract's `MAX_PAGE_SIZE`. */
export const MAX_PAGE_SIZE = 50;

export function addressScVal(value: string): xdr.ScVal {
  return nativeToScVal(new Address(value), { type: "address" });
}

export function u64ScVal(value: string | number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "u64" });
}

export function i128ScVal(value: string | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "i128" });
}

export function u32ScVal(value: number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "u32" });
}

export interface CreateStreamCall {
  sender: string;
  recipient: string;
  token: string;
  /** Deposit in smallest token units, as a decimal string or bigint. */
  deposit: string | bigint;
  startTime: number | bigint;
  endTime: number | bigint;
  cancelable: boolean;
}

/** `create_stream(sender, recipient, token, deposit, start, end, cancelable)`. */
export function createStreamOperation(
  contract: Contract,
  call: CreateStreamCall
): xdr.Operation {
  return contract.call(
    "create_stream",
    addressScVal(call.sender),
    addressScVal(call.recipient),
    addressScVal(call.token),
    i128ScVal(call.deposit),
    u64ScVal(call.startTime),
    u64ScVal(call.endTime),
    nativeToScVal(call.cancelable)
  );
}

/** `withdraw(stream_id, amount)` — recipient only. */
export function withdrawOperation(
  contract: Contract,
  streamId: string | number | bigint,
  amount: string | bigint
): xdr.Operation {
  return contract.call("withdraw", u64ScVal(streamId), i128ScVal(amount));
}

/** `withdraw_max(stream_id)` — recipient only, returns the amount paid. */
export function withdrawMaxOperation(
  contract: Contract,
  streamId: string | number | bigint
): xdr.Operation {
  return contract.call("withdraw_max", u64ScVal(streamId));
}

/** `top_up(stream_id, amount)` — sender only. */
export function topUpOperation(
  contract: Contract,
  streamId: string | number | bigint,
  amount: string | bigint
): xdr.Operation {
  return contract.call("top_up", u64ScVal(streamId), i128ScVal(amount));
}

/** `cancel_stream(caller, stream_id)` — sender, or recipient if cancelable. */
export function cancelStreamOperation(
  contract: Contract,
  caller: string,
  streamId: string | number | bigint
): xdr.Operation {
  return contract.call(
    "cancel_stream",
    addressScVal(caller),
    u64ScVal(streamId)
  );
}

/** `get_stream(stream_id)` — read-only. */
export function getStreamOperation(
  contract: Contract,
  streamId: string | number | bigint
): xdr.Operation {
  return contract.call("get_stream", u64ScVal(streamId));
}

/** `available(stream_id)` — read-only. */
export function availableOperation(
  contract: Contract,
  streamId: string | number | bigint
): xdr.Operation {
  return contract.call("available", u64ScVal(streamId));
}

/** `recipient_streams(address, offset, limit)` — read-only index page. */
export function recipientStreamsOperation(
  contract: Contract,
  recipient: string,
  offset: number,
  limit: number = MAX_PAGE_SIZE
): xdr.Operation {
  return contract.call(
    "recipient_streams",
    addressScVal(recipient),
    u32ScVal(offset),
    u32ScVal(limit)
  );
}

/** `sender_streams(address, offset, limit)` — read-only index page. */
export function senderStreamsOperation(
  contract: Contract,
  sender: string,
  offset: number,
  limit: number = MAX_PAGE_SIZE
): xdr.Operation {
  return contract.call(
    "sender_streams",
    addressScVal(sender),
    u32ScVal(offset),
    u32ScVal(limit)
  );
}
