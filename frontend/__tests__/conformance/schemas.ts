import { Asset, Operation, TransactionBuilder, Networks, Keypair, Account } from "@stellar/stellar-sdk";

/**
 * Canonical schema definitions for transactions the frontend is allowed to sign.
 *
 * These are the contract that the conformance suite enforces against the Freighter API surface.
 * Any change here is a deliberate protocol change and must be reviewed alongside
 * the contract authorization expectations.
 */

export const TESTNET_PASSPHRASE = Networks.TESTNET.networkPassphrase;
export const PUBLIC_PASSPHRASE = Networks.PUBLIC.networkPassphrase;

/** Maximum fee in strops the frontend is allowed to authorize. */
export const MAX_FEE_STROPS = 10_000n; // 0.001 XLM

/** Minimum fee in strops (1 base fee). */
export const MIN_FEE_STROPS = 100n;

/** Maximum number of operations per transaction. */
export const MAX_OPERATIONS = 100;

export interface SigningRequestSchema {
  networkPassphrase: string;
  fee: string;
  memo: string | null;
  operations: Array<{
    type: string;
    sourceAccount?: string;
    destination?: string;
    amount?: string;
    asset?: { code: string; issuer?: string } | { native: true };
  }>;
  timeout: number;
  signatures: Array<{ hint: string; signature: string }>;
}

export interface SigningResultSchema {
  signedXdr: string;
  networkPassphrase: string;
  hash: string;
  signerAddress: string;
}

/**
 * Extract a normalized, JSON-serializable view of a signed transaction.
 * This is the object the conformance assertions compare against the schema.
 */
export function normalizeTransaction(
  xdr: string,
  networkPassphrase: string,
): SigningRequestSchema {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  const ops = tx.operations.map((op) => {
    const base: SigningRequestSchema["operations"][number] = {
      type: op.type,
    };
    if (op.sourceAccount) base.sourceAccount = op.sourceAccount;
    if (op.type === "payment") {
      const payment = op as unknown as {
        destination: string;
        asset: Asset;
        amount: string;
      };
      base.destination = payment.destination;
      base.amount = payment.amount;
      base.asset = assetToSchema(payment.asset);
    }
    return base;
  });
  return {
    networkPassphrase,
    fee: tx.fee.toString(),
    memo: tx.memo ? tx.memo.value.toString() : null,
    operations: ops,
    timeout: Number(tx.timeBounds?.maxTime || 0),
    signatures: tx.signatures.map((s) => ({
      hint: s.hint().toString(),
      signature: Buffer.from(s.signature()).toBase64(),
    })),
  };
}

function assetToSchema(asset: Asset): SigningRequestSchema["operations"][number]["asset"] {
  if (asset.isNative()) {
    return { native: true };
  }
  return { code: asset.getCode(), issuer: asset.getIssuer() };
}

/**
 * Structural validation of a normalized signing request against the canonical schema.
 * Returns an array of human-readable violations (empty == conformant).
 */
export function validateSigningRequest(
  req: SigningRequestSchema,
  expectedNetworkPassphrase: string,
): string[] {
  const violations: string[] = [];

  if (req.networkPassphrase !== expectedNetworkPassphrase) {
    violations.push(
      `networkPassphrase mismatch: got "${req.networkPassphrase}", expected "${expectedNetworkPassphrase}"`,
    );
  }

  const fee = BigInt(req.fee);
  if (fee < MIN_FEE_STROPS) {
    violations.push(`fee ${fee} below minimum ${MIN_FEE_STROPS} strops`);
  }
  if (fee > MAX_FEE_STROPS) {
    violations.push(`fee ${fee} exceeds maximum ${MAX_FEE_STROPS} strops`);
  }

  if (req.memo !== null) {
    violations.push(`memo must be null for claims, got "${req.memo}"`);
  }

  if (req.operations.length === 0) {
    violations.push("transaction must contain at least one operation");
  }
  if (req.operations.length > MAX_OPERATIONS) {
    violations.push(`too many operations (${req.operations.length} > ${MAX_OPERATIONS})`);
  }

  for (const [i, op] of req.operations.entries()) {
    if (op.type === "payment") {
      if (!op.destination) violations.push(`operation[${i}] payment missing destination`);
      if (!op.amount) violations.push(`operation[${i}] payment missing amount`);
      if (!op.asset) violations.push(`operation[${i}] payment missing asset`);
    }
  }

  if (req.signatures.length === 0) {
    violations.push("transaction must be signed");
  }

  return violations;
}

export function validateSigningResult(
  result: SigningResultSchema,
  expectedNetworkPassphrase: string,
): string[] {
  const violations: string[] = [];
  if (!result.signedXdr) violations.push("signed xdr is empty");
  if (result.networkPassphrase !== expectedNetworkPassphrase) {
    violations.push(
      `signing result networkPassphrase mismatch: "${result.networkPassphrase}"`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(result.hash)) violations.push("hash is not a 256-bit hex string");
  if (!/^G[A-Z0-9]{56}$/.test(result.signerAddress)) {
    violations.push("signerAddress is not a valid Stellar address");
  }
  return violations;
}

/** Build a canonical claim transaction for the conformance suite. */
export async function buildClaimTransaction(params: {
  sourcePublicKey: string;
  destination: string;
  amount: string;
  asset: Asset;
  fee: string;
  networkPassphrase: string;
  timeoutSeconds?: number;
}): Promise<TransactionBuilder> {
  const account = await fetchAccount(params.sourcePublicKey, params.networkPassphrase);
  return new TransactionBuilder(
    new Account(params.sourcePublicKey, account.sequence),
    { fee: params.fee, networkPassphrase: params.networkPassphrase },
  )
    .addOperation(
      Operation.payment({
        destination: params.destination,
        amount: params.amount,
        asset: params.asset,
      }),
    )
    .setTimeout(params.timeoutSeconds ?? 300);
}

/** Fetch account details from the Horizon instance matching the passphrase. */
export async function fetchAccount(
  publicKey: string,
  networkPassphrase: string,
): Promise<{ sequence: string }> {
  const horizonUrl =
    networkPassphrase === Networks.PUBLIC.networkPassphrase
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org";
  const resp = await fetch(`${horizonUrl}/accounts/${publicKey}`);
  if (!resp.ok) {
    throw new Error(`failed to fetch account ${publicKey}: ${resp.status}`);
  }
  const json = (await resp.json()) as { sequence: string };
  return { sequence: json.sequence };
}

/** Derive a keypair from a deterministic seed for mocked mode. */
export function keypairFromSeed(seed: string): {
  publicKey: string;
  sign: (xdr: string, passphrase: string) => Promise<string>;
} {
  const kp = Keypair.fromSecret(seed);
  return {
    publicKey: kp.publicKey(),
    sign: async (xdr, passphrase) => {
      const tx = TransactionBuilder.fromXDR(xdr, passphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}
