import http from "http";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { DEPLOYER_KEYPAIR, SENDER_KEYPAIR, RECIPIENT_KEYPAIR } from "./signer";

export interface SandboxContext {
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  networkPassphrase: string;
  contractId: string;
  tokenId: string;
  deployer: Keypair;
  sender: Keypair;
  recipient: Keypair;
  server: rpc.Server;
  isMock: boolean;
  teardown: () => Promise<void>;
}

export interface StoredStream {
  id: bigint;
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  withdrawn: bigint;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: "Active" | "Cancelled" | "Depleted";
}

let mockServerInstance: http.Server | null = null;
export const mockStreams = new Map<bigint, StoredStream>();
let mockStreamIdSeq = 1n;
let mockLedgerSeq = 1000;
let mockLedgerTime = Math.floor(Date.now() / 1000) - 30;
let lastReturnedValue: xdr.ScVal = nativeToScVal(1n, { type: "u64" });

function encodeStreamToScVal(s: StoredStream): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("cancelable"),
      val: nativeToScVal(s.cancelable),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("deposit"),
      val: nativeToScVal(s.deposit, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("end_time"),
      val: nativeToScVal(BigInt(s.endTime), { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("id"),
      val: nativeToScVal(s.id, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("recipient"),
      val: new Address(s.recipient).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("sender"),
      val: new Address(s.sender).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("start_time"),
      val: nativeToScVal(BigInt(s.startTime), { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("status"),
      val: xdr.ScVal.scvSymbol(s.status),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("token"),
      val: new Address(s.token).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("withdrawn"),
      val: nativeToScVal(s.withdrawn, { type: "i128" }),
    }),
  ]);
}


function extractHostFunction(tx: any) {
  const op = tx?.operations?.[0];
  if (!op || !op.func) return { funcName: "", funcArgs: [] };
  const hostFunc = op.func.invokeContract;
  if (!hostFunc) return { funcName: "", funcArgs: [] };
  const funcName = hostFunc.functionName ? hostFunc.functionName.toString() : "";
  const funcArgs = hostFunc.args || [];
  return { funcName, funcArgs };
}

function createMockRpcServer(port: number = 8000): Promise<http.Server> {
  return new Promise((resolve) => {
    const dummyAccount = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
    const dummyEnvelope = new TransactionBuilder(dummyAccount, { fee: "100", networkPassphrase: Networks.STANDALONE })
      .setTimeout(30)
      .build()
      .toEnvelope()
      .toXDR("base64");

    const txResultXdr = new xdr.TransactionResult({
      feeCharged: 100n,
      result: xdr.TransactionResultResult.txSuccess([]),
      ext: xdr.TransactionResultExt.v0(),
    }).toXDR("base64");

    const server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/friendbot" || req.url?.startsWith("/friendbot?")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ successful: true }));
        return;
      }

      if (req.url === "/rpc" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          let reqJson: any = {};
          try {
            reqJson = JSON.parse(body);
          } catch {}

          const { id, method, params } = reqJson;
          let result: any = {};

          switch (method) {
            case "getHealth":
              result = { status: "healthy" };
              break;

            case "getLatestLedger":
              result = {
                id: "00000000000000000000000000000000000000000000000000000000000003e8",
                protocolVersion: 22,
                sequence: mockLedgerSeq++,
              };
              break;

            case "getLedgerEntries": {
              const keyStr = params?.keys?.[0] || "";
              let accountId = SENDER_KEYPAIR.xdrPublicKey();
              try {
                const lk = xdr.LedgerKey.fromXDR(keyStr, "base64");
                if (lk.switch().name === "account") {
                  accountId = lk.account().accountId();
                }
              } catch {}

              const accEntry = new xdr.AccountEntry({
                accountId,
                balance: 10_000_000_000n,
                seqNum: 100n,
                numSubEntries: 0,
                inflationDest: null,
                flags: 0,
                homeDomain: "",
                thresholds: Buffer.from([1, 0, 0, 0]),
                signers: [],
                ext: xdr.AccountEntryExt.v0(),
              });
              const ledgerEntryData = xdr.LedgerEntryData.account(accEntry);

              result = {
                entries: [{
                  key: keyStr,
                  xdr: ledgerEntryData.toXDR("base64"),
                  lastModifiedLedgerSeq: mockLedgerSeq,
                }],
                latestLedger: mockLedgerSeq,
              };
              break;
            }

            case "simulateTransaction": {
              try {
                const tx = TransactionBuilder.fromXDR(params?.transaction, Networks.STANDALONE);
                const { funcName, funcArgs } = extractHostFunction(tx);

                let retval = nativeToScVal(0);

                if (funcName === "get_stream") {
                  const sId = BigInt(scValToNative(funcArgs[0]));
                  const stream = mockStreams.get(sId);
                  if (stream) {
                    retval = encodeStreamToScVal(stream);
                  }
                } else if (funcName === "available") {
                  const sId = BigInt(scValToNative(funcArgs[0]));
                  const stream = mockStreams.get(sId);
                  if (stream && stream.status === "Active") {
                    const now = Math.floor(Date.now() / 1000);
                    if (now <= stream.startTime) {
                      retval = nativeToScVal(0n, { type: "i128" });
                    } else {
                      const elapsed = BigInt(Math.min(now, stream.endTime) - stream.startTime);
                      const duration = BigInt(stream.endTime - stream.startTime);
                      const streamed = duration > 0n ? (stream.deposit * elapsed) / duration : 0n;
                      const avail = streamed > stream.withdrawn ? streamed - stream.withdrawn : 0n;
                      retval = nativeToScVal(avail, { type: "i128" });
                    }
                  } else {
                    retval = nativeToScVal(0n, { type: "i128" });
                  }
                } else if (funcName === "recipient_streams" || funcName === "sender_streams") {
                  const addr = Address.fromScVal(funcArgs[0]).toString();
                  const offset = Number(scValToNative(funcArgs[1]) || 0);
                  const limit = Number(scValToNative(funcArgs[2]) || 50);
                  const matching = Array.from(mockStreams.values())
                    .filter((s) => (funcName === "recipient_streams" ? s.recipient === addr : s.sender === addr))
                    .map((s) => s.id)
                    .slice(offset, offset + limit);
                  retval = nativeToScVal(matching);
                } else if (funcName === "create_stream") {
                  const newId = mockStreamIdSeq++;
                  retval = nativeToScVal(newId, { type: "u64" });
                  lastReturnedValue = retval;
                  try {
                    const deposit = BigInt(scValToNative(funcArgs[3]));
                    const startTime = Number(scValToNative(funcArgs[4]));
                    const endTime = Number(scValToNative(funcArgs[5]));
                    mockStreams.set(newId, {
                      id: newId,
                      sender: scValToNative(funcArgs[0]),
                      recipient: scValToNative(funcArgs[1]),
                      token: scValToNative(funcArgs[2]),
                      deposit,
                      withdrawn: 0n,
                      startTime,
                      endTime,
                      cancelable: Boolean(scValToNative(funcArgs[6])),
                      status: "Active",
                    });
                  } catch {}
                } else if (funcName === "cancel_stream") {
                  retval = nativeToScVal(null);
                  lastReturnedValue = retval;
                } else if (funcName === "withdraw_max") {
                  const sId = BigInt(scValToNative(funcArgs[0]));
                  const stream = mockStreams.get(sId);
                  const avail = stream ? stream.deposit / 2n : 500_000n;
                  retval = nativeToScVal(avail, { type: "i128" });
                  lastReturnedValue = retval;
                }

                result = {
                  results: [{
                    auth: [],
                    xdr: retval.toXDR("base64"),
                    retval: retval.toXDR("base64"),
                  }],
                  latestLedger: mockLedgerSeq,
                  minResourceFee: "100",
                  transactionData: new xdr.SorobanTransactionData({
                    ext: xdr.ExtensionPoint.v0(),
                    resources: new xdr.SorobanResources({
                      footprint: new xdr.LedgerFootprint({
                        readOnly: [],
                        readWrite: [],
                      }),
                      instructions: 200_000,
                      diskReadBytes: 1000,
                      writeBytes: 1000,
                    }),
                    resourceFee: 100n,
                  }).toXDR("base64"),
                };
              } catch (e: any) {
                result = {
                  error: e?.message || "Simulation error",
                  latestLedger: mockLedgerSeq,
                  minResourceFee: "100",
                };
              }
              break;
            }

            case "sendTransaction": {
              try {
                const tx = TransactionBuilder.fromXDR(params?.transaction, Networks.STANDALONE);
                const { funcName, funcArgs } = extractHostFunction(tx);

                if (funcName === "create_stream") {
                  const sId = mockStreamIdSeq > 1n ? mockStreamIdSeq - 1n : 1n;
                  const deposit = BigInt(scValToNative(funcArgs[3]));
                  const startTime = Number(scValToNative(funcArgs[4]));
                  const endTime = Number(scValToNative(funcArgs[5]));
                  mockStreams.set(sId, {
                    id: sId,
                    sender: scValToNative(funcArgs[0]),
                    recipient: scValToNative(funcArgs[1]),
                    token: scValToNative(funcArgs[2]),
                    deposit,
                    withdrawn: 0n,
                    startTime,
                    endTime,
                    cancelable: Boolean(scValToNative(funcArgs[6])),
                    status: "Active",
                  });
                  lastReturnedValue = nativeToScVal(sId, { type: "u64" });
                } else if (funcName === "withdraw_max" || funcName === "withdraw") {
                  const sId = BigInt(scValToNative(funcArgs[0]));
                  const stream = mockStreams.get(sId);
                  if (stream) {
                    const toWithdraw = funcName === "withdraw_max" ? 500_000n : BigInt(scValToNative(funcArgs[1]));
                    stream.withdrawn += toWithdraw;
                    lastReturnedValue = nativeToScVal(toWithdraw, { type: "i128" });
                  }
                } else if (funcName === "cancel_stream") {
                  const sId = BigInt(scValToNative(funcArgs[1]));
                  const stream = mockStreams.get(sId);
                  if (stream) {
                    stream.status = "Cancelled";
                  }
                }
              } catch (e) {
                // Ignore parse errors in mock
              }

              result = {
                status: "PENDING",
                hash: "mock-tx-hash-" + Date.now(),
              };
              break;
            }

            case "getTransaction": {
              const sorobanMeta = new xdr.SorobanTransactionMeta({
                ext: xdr.ExtensionPoint.v0(),
                events: [],
                returnValue: lastReturnedValue,
                diagnosticEvents: [],
              });

              const metaV3 = new xdr.TransactionMetaV3({
                ext: xdr.ExtensionPoint.v0(),
                txChangesBefore: [],
                operations: [],
                txChangesAfter: [],
                sorobanMeta,
              });

              const txMeta = xdr.TransactionMeta.v3(metaV3);

              result = {
                status: "SUCCESS",
                latestLedger: mockLedgerSeq,
                latestLedgerCloseTime: mockLedgerTime,
                envelopeXdr: dummyEnvelope,
                resultXdr: txResultXdr,
                resultMetaXdr: txMeta.toXDR("base64"),
              };
              break;
            }

            default:
              result = {};
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

async function isUrlReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res.ok || res.status === 400 || res.status === 404;
  } catch {
    clearTimeout(id);
    return false;
  }
}

export async function setupSandbox(): Promise<SandboxContext> {
  const rpcUrl =
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
    process.env.SOROBAN_RPC_URL ||
    "http://localhost:8000/rpc";
  const horizonUrl = process.env.STELLAR_HORIZON_URL || "http://localhost:8000";
  const friendbotUrl = process.env.STELLAR_FRIENDBOT_URL || "http://localhost:8000/friendbot";
  const networkPassphrase =
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.STANDALONE;

  let isMock = false;
  const isHealthy = await isUrlReachable(friendbotUrl, 1500);

  if (!isHealthy) {
    if (!mockServerInstance) {
      mockServerInstance = await createMockRpcServer(8000);
    }
    isMock = true;
  }

  const server = new rpc.Server(rpcUrl, { allowHttp: true });

  // Fund test accounts via friendbot
  for (const kp of [DEPLOYER_KEYPAIR, SENDER_KEYPAIR, RECIPIENT_KEYPAIR]) {
    try {
      await fetch(`${friendbotUrl}?addr=${encodeURIComponent(kp.publicKey())}`);
    } catch {
      // Ignored if friendbot is mock or already funded
    }
  }

  // Pre-seed an initial active demo stream into mock data if running in mock mode
  if (isMock && mockStreams.size === 0) {
    mockStreams.set(1n, {
      id: 1n,
      sender: SENDER_KEYPAIR.publicKey(),
      recipient: RECIPIENT_KEYPAIR.publicKey(),
      token: "CAZVGOIWOGDYIDFA2Q54VU6KLV4TJAKRVICOQPWBO2XEWSPHTCGABQMY",
      deposit: 1000000000n,
      withdrawn: 0n,
      startTime: Math.floor(Date.now() / 1000) - 3600,
      endTime: Math.floor(Date.now() / 1000) + 3600,
      cancelable: true,
      status: "Active",
    });
    mockStreamIdSeq = 2n;
  }

  let contractId =
    process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID ||
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  const demoAsset = new Asset("DEMO", DEPLOYER_KEYPAIR.publicKey());
  const tokenId = demoAsset.contractId(networkPassphrase);

  // If connected to a real live network and stellar CLI is installed, attempt real deploy
  if (!isMock && !process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID) {
    try {
      const repoRoot = path.resolve(__dirname, "../..");
      const wasmPath = path.join(
        repoRoot,
        "target/wasm32v1-none/release/streampay_contract.wasm"
      );
      if (fs.existsSync(wasmPath)) {
        const out = execSync(
          `stellar contract deploy --wasm "${wasmPath}" --source "${DEPLOYER_KEYPAIR.secret()}" --network-passphrase "${networkPassphrase}" --rpc-url "${rpcUrl}"`,
          { encoding: "utf-8" }
        ).trim();
        const lines = out.split(String.fromCharCode(10));
        const deployedId = lines[lines.length - 1].trim();
        if (deployedId.startsWith("C") && deployedId.length === 56) {
          contractId = deployedId;
        }
      }
    } catch {
      // If CLI deploy isn't available or fails, use fallback deterministic contract id
    }
  }

  return {
    rpcUrl,
    horizonUrl,
    friendbotUrl,
    networkPassphrase,
    contractId,
    tokenId,
    deployer: DEPLOYER_KEYPAIR,
    sender: SENDER_KEYPAIR,
    recipient: RECIPIENT_KEYPAIR,
    server,
    isMock,
    teardown: async () => {
      if (mockServerInstance) {
        mockServerInstance.close();
        mockServerInstance = null;
      }
    },
  };
}
