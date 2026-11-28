import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  AssetAllowlistPanel,
  GovernanceAuditLogPanel,
  GovernanceQueuePanel,
  GovernorSetPanel,
  KeyRotationPanel,
  PolicyBoundsPanel,
} from "./GovernancePanels";
import MutationConfirmation from "./MutationConfirmation";
import { RECIPIENT, REFUND_TARGET, SENDER } from "../.storybook/fixtures";
import type { AuditEntry, GovernanceSnapshot } from "../lib/governance";

const now = 1_800_000_000n;
const token = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const policy = { minRate: "1", maxRate: "100", minDuration: "60", maxDuration: "86400", minDeposit: "100" };
const snapshot: GovernanceSnapshot = {
  initialized: true,
  signers: [SENDER, RECIPIENT],
  vetoWindow: 86_400n,
  proposalCount: 2n,
  proposals: [
    {
      id: "2",
      action: { variant: "SetSigners", payload: [[SENDER, RECIPIENT, REFUND_TARGET]] },
      proposedBy: SENDER,
      proposedAt: now,
      executableAt: now + 345_600n,
      signers: [SENDER],
      vetoed: false,
      executed: false,
    },
    {
      id: "1",
      action: { variant: "SetStreamPolicy", payload: [null, policy] },
      proposedBy: RECIPIENT,
      proposedAt: now - 86_400n,
      executableAt: now,
      signers: [SENDER, RECIPIENT],
      vetoed: false,
      executed: false,
    },
  ],
  governor: SENDER,
  pendingGovernor: REFUND_TARGET,
  policyAdmin: REFUND_TARGET,
  pendingPolicyAdmin: null,
  policyTimelockDelay: 86_400n,
  globalPolicy: policy,
  assets: [{ asset: token, allowed: true, queued: { allowed: false, queuedAt: now - 3_600n, executableAfter: now + 82_800n } }],
  ledgerTimestamp: now,
};
const entries: AuditEntry[] = [{
  id: "audit-1",
  at: "2027-01-15T08:00:00.000Z",
  actor: SENDER,
  action: "Sign proposal #1",
  status: "submitted",
  txHash: "5f…c2",
}];

// Linux pixel baselines require the pinned container; governance behavior is covered by the dedicated specs.
const meta = {
  title: "Governance/Panels",
  tags: ["autodocs", "no-visual"],
  parameters: { wallet: { connectionState: "connected", address: SENDER } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
const review = fn();

export const TimelockQueue: Story = {
  render: () => <GovernanceQueuePanel snapshot={snapshot} address={SENDER} now={now} busy={false} onReview={review} />,
};

export const QueueReadOnly: Story = {
  render: () => <GovernanceQueuePanel snapshot={snapshot} address={REFUND_TARGET} now={now} busy={false} onReview={review} />,
};

export const PolicyBounds: Story = {
  render: () => <PolicyBoundsPanel snapshot={snapshot} address={SENDER} now={now} busy={false} onReview={review} />,
};

export const AssetAllowlist: Story = {
  render: () => <AssetAllowlistPanel snapshot={snapshot} address={REFUND_TARGET} now={now} busy={false} onReview={review} onInspect={fn()} />,
};

export const GovernorSet: Story = {
  render: () => <GovernorSetPanel snapshot={snapshot} address={SENDER} now={now} busy={false} onReview={review} />,
};

export const KeyRotation: Story = {
  render: () => <KeyRotationPanel snapshot={snapshot} address={SENDER} now={now} busy={false} onReview={review} />,
};

export const ClientAuditLog: Story = {
  render: () => <GovernanceAuditLogPanel entries={entries} onClear={fn()} />,
};

export const Confirmation: Story = {
  render: () => <MutationConfirmation
    effect={{ title: "Replace governance signer set with 3 keys", details: ["Rotation waits four veto windows.", "One current signer signature is required."], delaySeconds: 345_600n, requiredSignatures: 1 }}
    prepared={{ xdr: "story-xdr", minFee: "12345", preparedAt: Date.now() }}
    busy={false}
    error={null}
    onCancel={fn()}
    onConfirm={fn()}
  />,
};
