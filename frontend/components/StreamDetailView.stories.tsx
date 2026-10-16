import type { Meta, StoryObj } from "@storybook/react";
import StreamDetailView from "./StreamDetailView";

const mockActiveStream = {
  id: "42",
  sender: "GDHKQY6...SENDER1",
  recipient: "GBV4TNK...RECIPIENT1",
  token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  deposit: "100000000",
  withdrawn: "25000000",
  startTime: 1699950000,
  endTime: 1700100000,
  cancelable: true,
  status: "Active" as const,
};

const meta: Meta<typeof StreamDetailView> = {
  title: "Composites/StreamDetailView",
  component: StreamDetailView,
  args: {
    id: "42",
  },
};

export default meta;
type Story = StoryObj<typeof StreamDetailView>;

// 1. Loading state
export const Loading: Story = {
  args: {
    stream: null,
    loadError: "",
  },
};

// 2. Error state
export const ErrorState: Story = {
  args: {
    stream: null,
    loadError: "Stream not found. The stream may have been purged or the ID is invalid.",
  },
};

// 3. Connected state: recipient view with active withdrawal form
export const ConnectedRecipient: Story = {
  args: {
    stream: mockActiveStream,
    address: "GBV4TNK...RECIPIENT1",
    available: 35000000n,
    displayAvailable: 35000000n,
    amount: "10000000",
  },
};

// 4. Connected state: sender view with cancellation form
export const ConnectedSender: Story = {
  args: {
    stream: mockActiveStream,
    address: "GDHKQY6...SENDER1",
    available: 35000000n,
    displayAvailable: 35000000n,
  },
};

// 5. Read-only / unconnected view
export const ReadOnly: Story = {
  args: {
    stream: mockActiveStream,
    address: null,
    available: 35000000n,
    displayAvailable: 35000000n,
  },
};

// 6. Over-withdrawal error state
export const OverWithdrawalError: Story = {
  args: {
    stream: mockActiveStream,
    address: "GBV4TNK...RECIPIENT1",
    available: 35000000n,
    displayAvailable: 35000000n,
    amount: "50000000",
  },
};
