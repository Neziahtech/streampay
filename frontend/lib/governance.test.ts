import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scValToNative } from "@stellar/stellar-sdk";
import {
  canReviewMutation,
  decodeGovernanceAction,
  describeMutation,
  encodeGovernanceAction,
  proposalView,
  validatePolicy,
  validateSignerSet,
  validateVetoWindow,
  type GovernanceAction,
  type GovernanceSnapshot,
} from "./governance.ts";

const SIGNER_A = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const SIGNER_B = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";
const OUTSIDER = "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POLICY = { minRate: "1", maxRate: "100", minDuration: "60", maxDuration: "86400", minDeposit: "100" };

function snapshot(): GovernanceSnapshot {
  return {
    initialized: true,
    signers: [SIGNER_A, SIGNER_B],
    vetoWindow: 86_400n,
    proposalCount: 1n,
    proposals: [{
      id: "1",
      action: { variant: "SetStreamPolicy", payload: [null, POLICY] },
      proposedBy: SIGNER_A,
      proposedAt: 100n,
      executableAt: 186_400n,
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
    assets: [],
    ledgerTimestamp: 200n,
  };
}

describe("governance model", () => {
  it("round-trips the supported contract action encodings", () => {
    const actions: GovernanceAction[] = [
      { variant: "SetSigners", payload: [[SIGNER_A, SIGNER_B]] },
      { variant: "SetStreamPolicy", payload: [TOKEN, POLICY] },
      { variant: "SetStreamPolicy", payload: [null, POLICY] },
      { variant: "SetVetoWindow", payload: ["172800"] },
      { variant: "ProposeUpgrade", payload: ["ab".repeat(32), "86400"] },
    ];
    for (const action of actions) {
      assert.deepEqual(decodeGovernanceAction(scValToNative(encodeGovernanceAction(action))), action);
    }
  });

  it("derives readiness from live signer membership and timelock time", () => {
    const state = snapshot();
    const proposal = state.proposals[0];
    assert.equal(proposalView(proposal, state.signers, 200n).status, "awaiting_timelock");
    assert.equal(proposalView(proposal, state.signers, 186_400n).status, "awaiting_signatures");
    assert.equal(proposalView({ ...proposal, signers: [SIGNER_A, SIGNER_B] }, state.signers, 186_400n).status, "ready");
    assert.equal(proposalView(proposal, [SIGNER_B], 186_400n).status, "awaiting_signatures");
    assert.equal(proposalView({ ...proposal, signers: [SIGNER_B], action: { variant: "SetSigners", payload: [[SIGNER_A, SIGNER_B]] } }, [SIGNER_B], 186_400n).status, "ready");
  });

  it("shows the exact longer key-rotation delay", () => {
    const state = snapshot();
    const effect = describeMutation({ kind: "propose", action: { variant: "SetSigners", payload: [[SIGNER_A, SIGNER_B]] } }, state);
    assert.equal(effect.delaySeconds, 345_600n);
    assert.equal(effect.requiredSignatures, 1);
    assert.match(effect.details.join(" "), /four-times-longer/);
  });

  it("gates signer, policy-admin, and nominee controls independently", () => {
    const state = snapshot();
    assert.equal(canReviewMutation({ kind: "sign", proposalId: "1" }, state, SIGNER_A), true);
    assert.equal(canReviewMutation({ kind: "sign", proposalId: "1" }, state, OUTSIDER), false);
    assert.equal(canReviewMutation({ kind: "assetPropose", asset: TOKEN, allowed: true }, state, OUTSIDER), true);
    assert.equal(canReviewMutation({ kind: "assetPropose", asset: TOKEN, allowed: true }, state, SIGNER_A), false);
    assert.equal(canReviewMutation({ kind: "governorAccept" }, { ...state, pendingGovernor: OUTSIDER }, OUTSIDER), true);
    const handoff = { ...state, policyAdmin: SIGNER_A, pendingPolicyAdmin: OUTSIDER };
    assert.equal(canReviewMutation({ kind: "policyAcceptHandoff" }, handoff, OUTSIDER), true);
    assert.equal(canReviewMutation({ kind: "policyAcceptHandoff" }, handoff, SIGNER_A), false);
    assert.equal(canReviewMutation({ kind: "assetPropose", asset: TOKEN, allowed: true }, handoff, OUTSIDER), false);
    assert.equal(canReviewMutation({ kind: "policyCancelHandoff" }, handoff, SIGNER_A), true);
  });

  it("rejects unsafe policy, signer, and veto-window inputs", () => {
    assert.throws(() => validatePolicy({ ...POLICY, minRate: "101" }), /Minimum rate/);
    assert.throws(() => validateSignerSet([SIGNER_A, SIGNER_A]), /distinct/);
    assert.throws(() => validateSignerSet([SIGNER_A]), /2–10/);
    assert.throws(() => validateVetoWindow("60"), /at least 86400/);
    assert.equal(validateVetoWindow("86400"), 86_400n);
  });
});
