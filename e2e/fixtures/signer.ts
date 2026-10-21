import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Page } from "@playwright/test";

// Deterministic 32-byte seeds for repeatable testing across runs
const SEED_DEPLOYER = Buffer.alloc(32, 1);
const SEED_SENDER = Buffer.alloc(32, 2);
const SEED_RECIPIENT = Buffer.alloc(32, 3);

export const DEPLOYER_KEYPAIR = Keypair.fromRawEd25519Seed(SEED_DEPLOYER);
export const SENDER_KEYPAIR = Keypair.fromRawEd25519Seed(SEED_SENDER);
export const RECIPIENT_KEYPAIR = Keypair.fromRawEd25519Seed(SEED_RECIPIENT);

export type AccountRole = "sender" | "recipient" | "deployer";

export interface DeterministicSigner {
  deployer: Keypair;
  sender: Keypair;
  recipient: Keypair;
  getActiveAccount: () => AccountRole;
  getActiveKeypair: () => Keypair;
  setActiveAccount: (role: AccountRole | Keypair) => Promise<void>;
  signTx: (xdr: string, passphrase?: string) => { signedTxXdr: string; signerAddress: string };
  setupBypass: (page: Page, networkPassphrase?: string, rpcUrl?: string) => Promise<void>;
}

export function createDeterministicSigner(
  defaultRole: AccountRole = "sender",
  defaultPassphrase: string = Networks.STANDALONE,
  defaultRpcUrl: string = "http://localhost:8000/rpc"
): DeterministicSigner {
  let activeRole: AccountRole = defaultRole;
  let activeKeypair: Keypair =
    defaultRole === "recipient"
      ? RECIPIENT_KEYPAIR
      : defaultRole === "deployer"
      ? DEPLOYER_KEYPAIR
      : SENDER_KEYPAIR;

  let registeredPage: Page | null = null;

  const signer: DeterministicSigner = {
    deployer: DEPLOYER_KEYPAIR,
    sender: SENDER_KEYPAIR,
    recipient: RECIPIENT_KEYPAIR,

    getActiveAccount: () => activeRole,
    getActiveKeypair: () => activeKeypair,

    setActiveAccount: async (roleOrKeypair: AccountRole | Keypair) => {
      if (typeof roleOrKeypair === "string") {
        activeRole = roleOrKeypair;
        activeKeypair =
          roleOrKeypair === "recipient"
            ? RECIPIENT_KEYPAIR
            : roleOrKeypair === "deployer"
            ? DEPLOYER_KEYPAIR
            : SENDER_KEYPAIR;
      } else {
        activeKeypair = roleOrKeypair;
        if (roleOrKeypair.publicKey() === RECIPIENT_KEYPAIR.publicKey()) {
          activeRole = "recipient";
        } else if (roleOrKeypair.publicKey() === DEPLOYER_KEYPAIR.publicKey()) {
          activeRole = "deployer";
        } else {
          activeRole = "sender";
        }
      }

      if (registeredPage) {
        // Notify the in-page bypass script that the active address changed
        await registeredPage.evaluate((newAddress) => {
          if (typeof window !== "undefined") {
            (window as any).__E2E_CURRENT_ADDRESS = newAddress;
            window.dispatchEvent(
              new CustomEvent("freighter:accountChanged", { detail: { address: newAddress } })
            );
          }
        }, activeKeypair.publicKey()).catch(() => {});
      }
    },

    signTx: (xdr: string, passphrase?: string) => {
      const net = passphrase || defaultPassphrase;
      const tx = TransactionBuilder.fromXDR(xdr, net);
      tx.sign(activeKeypair);
      return {
        signedTxXdr: tx.toXDR(),
        signerAddress: activeKeypair.publicKey(),
      };
    },

    setupBypass: async (
      page: Page,
      networkPassphrase: string = defaultPassphrase,
      rpcUrl: string = defaultRpcUrl
    ) => {
      registeredPage = page;

      // Expose deterministic signing helpers to page context safely
      try {
        await page.exposeFunction("__e2eGetActiveAddress", () => activeKeypair.publicKey());
      } catch {}
      try {
        await page.exposeFunction("__e2eGetNetwork", () => ({
          network: "STANDALONE",
          networkName: "Standalone Network",
          networkUrl: rpcUrl,
          networkPassphrase,
          sorobanRpcUrl: rpcUrl,
        }));
      } catch {}
      try {
        await page.exposeFunction("__e2eSignTx", (txXdr: string, passphrase?: string) => {
          return signer.signTx(txXdr, passphrase || networkPassphrase);
        });
      } catch {}

      // Inject deterministic dev-mode Freighter bypass before any page script loads
      await page.addInitScript(
        ({ initialAddress, networkPassphrase, rpcUrl }) => {
          (window as any).__E2E_CURRENT_ADDRESS = initialAddress;
          (window as any).freighter = true;
          (window as any).__FREIGHTER_BYPASS__ = true;

          const getAddr = async () => {
            if (typeof (window as any).__e2eGetActiveAddress === "function") {
              try {
                return await (window as any).__e2eGetActiveAddress();
              } catch {}
            }
            return (window as any).__E2E_CURRENT_ADDRESS || "";
          };

          // Direct Freighter API shim for apps calling window.freighterApi
          (window as any).freighterApi = {
            isConnected: async () => ({ isConnected: true }),
            isAllowed: async () => ({ isAllowed: true }),
            setAllowed: async () => ({ isAllowed: true }),
            requestAccess: async () => {
              const address = await getAddr();
              return { address };
            },
            getAddress: async () => {
              const address = await getAddr();
              return { address };
            },
            signTransaction: async (transactionXdr: string, opts?: { networkPassphrase?: string }) => {
              const net = await (window as any).__e2eGetNetwork();
              const passphrase = opts?.networkPassphrase || net.networkPassphrase;
              const res = await (window as any).__e2eSignTx(transactionXdr, passphrase);
              return {
                signedTxXdr: res.signedTxXdr,
                signerAddress: res.signerAddress,
              };
            },
            getNetwork: async () => {
              const net = await (window as any).__e2eGetNetwork();
              return { network: net.network, networkPassphrase: net.networkPassphrase };
            },
            getNetworkDetails: async () => {
              return await (window as any).__e2eGetNetwork();
            },
          };

          // Message listener for @stellar/freighter-api window.postMessage protocol
          window.addEventListener("message", async (event) => {
            if (
              event.source !== window ||
              !event.data ||
              event.data.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST"
            ) {
              return;
            }

            const { type, messageId, transactionXdr, networkPassphrase: txPassphrase } = event.data;

            const reply = (payload: Record<string, any>) => {
              window.postMessage(
                {
                  source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
                  messagedId: messageId,
                  ...payload,
                },
                "*"
              );
            };

            try {
              switch (type) {
                case "REQUEST_CONNECTION_STATUS":
                  reply({ isConnected: true });
                  break;

                case "REQUEST_ACCESS":
                case "REQUEST_PUBLIC_KEY": {
                  const address = await getAddr();
                  reply({ publicKey: address, address });
                  break;
                }

                case "REQUEST_ALLOWED_STATUS":
                case "SET_ALLOWED_STATUS":
                  reply({ isAllowed: true });
                  break;

                case "REQUEST_NETWORK_DETAILS": {
                  const net = await (window as any).__e2eGetNetwork();
                  reply({ networkDetails: net });
                  break;
                }

                case "REQUEST_NETWORK": {
                  const net = await (window as any).__e2eGetNetwork();
                  reply({ network: net.network, networkPassphrase: net.networkPassphrase });
                  break;
                }

                case "SUBMIT_TRANSACTION": {
                  const net = await (window as any).__e2eGetNetwork();
                  const passphrase = txPassphrase || net.networkPassphrase;
                  const res = await (window as any).__e2eSignTx(transactionXdr, passphrase);
                  reply({
                    signedTransaction: res.signedTxXdr,
                    signerAddress: res.signerAddress,
                  });
                  break;
                }

                default:
                  reply({});
              }
            } catch (err: any) {
              reply({ apiError: err?.message || String(err) });
            }
          });
        },
        {
          initialAddress: activeKeypair.publicKey(),
          networkPassphrase,
          rpcUrl,
        }
      );
    },
  };

  return signer;
}
