// @vitest-environment jsdom

import { act, type ComponentPropsWithoutRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GovernanceConsole from "./GovernanceConsole";
import type { GovernanceSnapshot } from "@/lib/governance";

const SIGNER_A = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const SIGNER_B = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";
const OUTSIDER = "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POLICY = { minRate: "1", maxRate: "100", minDuration: "60", maxDuration: "86400", minDeposit: "100" };

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  prepare: vi.fn(),
  submit: vi.fn(),
  readAsset: vi.fn(),
  wallet: {
    address: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
    walletName: "Freighter",
    connectionState: "connected",
    network: "Test SDF Network ; September 2015",
    lastError: null,
    walletId: "freighter",
    disconnect: vi.fn(),
    signTransaction: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: ComponentPropsWithoutRef<"a">) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/lib/wallet-context", () => ({ useWallet: () => mocks.wallet }));
vi.mock("@/lib/stellar", () => ({
  NETWORK_LABEL: "testnet",
  NATIVE_XLM: "native",
  tokenContractId: () => TOKEN,
}));
vi.mock("@/lib/governance-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/governance-client")>();
  return {
    ...actual,
    readGovernanceSnapshot: mocks.read,
    prepareGovernanceMutation: mocks.prepare,
    submitPreparedGovernanceMutation: mocks.submit,
    readAssetPolicy: mocks.readAsset,
  };
});

let container: HTMLDivElement;
let root: Root;

function fixture(): GovernanceSnapshot {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    initialized: true,
    signers: [SIGNER_A, SIGNER_B],
    vetoWindow: 86_400n,
    proposalCount: 1n,
    proposals: [{
      id: "1",
      action: { variant: "SetStreamPolicy", payload: [null, POLICY] },
      proposedBy: SIGNER_A,
      proposedAt: now,
      executableAt: now + 3_600n,
      signers: [SIGNER_A],
      vetoed: false,
      executed: false,
    }],
    governor: SIGNER_A,
    pendingGovernor: null,
    policyAdmin: OUTSIDER,
    pendingPolicyAdmin: null,
    policyTimelockDelay: 86_400n,
    globalPolicy: POLICY,
    assets: [{ asset: TOKEN, allowed: true, queued: null }],
    ledgerTimestamp: now,
  };
}

async function render() {
  await act(async () => root.render(<GovernanceConsole />));
  await act(async () => {
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled());
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.clear();
  mocks.wallet.address = SIGNER_A;
  mocks.wallet.connectionState = "connected";
  mocks.read.mockResolvedValue(fixture());
  mocks.prepare.mockResolvedValue({ xdr: "prepared-xdr", minFee: "123", preparedAt: Date.now() });
  mocks.submit.mockResolvedValue({ txHash: "txhash", result: null });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("GovernanceConsole", () => {
  it("renders the timelock queue with countdown, status, and live signature count", async () => {
    await render();
    expect(container.textContent).toContain("Timelock queue");
    expect(container.textContent).toContain("#1");
    expect(container.textContent).toContain("awaiting timelock");
    expect(container.textContent).toContain("1/2 current");
    expect(container.textContent).toContain("remaining");
    expect(container.querySelector('[data-proposal-id="1"]')?.textContent).toContain("Set global stream policy");
  });

  it("simulates before confirmation and never submits without explicit acknowledgement", async () => {
    await render();
    const review = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Review policy proposal"));
    expect(review).toBeDefined();
    await act(async () => review!.click());

    expect(mocks.prepare).toHaveBeenCalledWith(SIGNER_A, expect.objectContaining({ kind: "propose" }));
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Simulation succeeded");
    const submit = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Sign and submit")) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const acknowledgement = container.querySelector<HTMLInputElement>(".governance-ack input")!;
    await act(async () => acknowledgement.click());
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ xdr: "prepared-xdr" }), mocks.wallet.signTransaction);
    expect(container.textContent).toContain("submitted");
  });

  it("blocks submission when the connected wallet changes after simulation", async () => {
    await render();
    const review = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Review policy proposal"));
    await act(async () => review!.click());
    mocks.wallet.address = SIGNER_B;
    const refresh = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Refresh chain state");
    await act(async () => refresh!.click());
    const acknowledgement = container.querySelector<HTMLInputElement>(".governance-ack input")!;
    await act(async () => acknowledgement.click());
    const submit = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Sign and submit")) as HTMLButtonElement;
    await act(async () => submit.click());
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("connected wallet changed after simulation");
  });

  it("keeps unauthorized wallets read-only and hides mutation controls", async () => {
    mocks.wallet.address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF";
    await render();
    expect(container.textContent).toContain("Read-only mode");
    expect(container.textContent).toContain("Timelock queue");
    expect(Array.from(container.querySelectorAll("button")).some((button) => /^(Sign|Veto|Execute|Review)/.test(button.textContent ?? ""))).toBe(false);
  });

  it("lets only the pending policy-admin nominee accept a handoff", async () => {
    mocks.wallet.address = OUTSIDER;
    mocks.read.mockResolvedValue({ ...fixture(), policyAdmin: SIGNER_A, pendingPolicyAdmin: OUTSIDER });
    await render();
    expect(container.textContent).not.toContain("Read-only mode");
    const accept = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Accept handoff");
    expect(accept).toBeDefined();
    expect(Array.from(container.querySelectorAll("button")).some((button) => /Queue allow|Cancel handoff/.test(button.textContent ?? ""))).toBe(false);
    await act(async () => accept!.click());
    expect(mocks.prepare).toHaveBeenCalledWith(OUTSIDER, { kind: "policyAcceptHandoff" });
  });

  it("surfaces simulation failures and does not open a submission confirmation", async () => {
    mocks.prepare.mockRejectedValue(new Error("GovernanceSignersNotDistinct"));
    await render();
    const review = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Review policy proposal"));
    await act(async () => review!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("GovernanceSignersNotDistinct");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(container.querySelector(".governance-confirm")).toBeNull();
  });
});
