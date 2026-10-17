/** Stellar Asset Contract operations the canary needs (approve/balance). */
import { Contract, xdr } from "@stellar/stellar-sdk";

import {
  addressScVal,
  i128ScVal,
  u32ScVal,
} from "../../../frontend/lib/contract-ops.ts";

/** `approve(from, spender, amount, expiration_ledger)` on a SAC token. */
export function approveOperation(
  token: Contract,
  from: string,
  spender: string,
  amount: bigint,
  expirationLedger: number
): xdr.Operation {
  return token.call(
    "approve",
    addressScVal(from),
    addressScVal(spender),
    i128ScVal(amount),
    u32ScVal(expirationLedger)
  );
}

/** `balance(address)` on a SAC token. */
export function balanceOperation(
  token: Contract,
  address: string
): xdr.Operation {
  return token.call("balance", addressScVal(address));
}
