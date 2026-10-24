import type { Meta, StoryObj } from "@storybook/react";
import StreamDashboardView from "./StreamDashboardView";

const mockStreams = [
  {
    id: "1",
    sender: "GDHKQY6...SENDER1",
    recipient: "GBV4TNK...RECIPIENT1",
    token: "native",
    deposit: "50000000",
    withdrawn: "10000000",
    startTime: 1699950000,
    endTime: 1700100000,
    cancelable: true,
    status: "Active" as const,
  },
  {
    id: "2",
    sender: "GDHKQY6...SENDER1",
    recipient: "GA7QYNF...RECIPIENT2",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    deposit: "200000000",
    withdrawn: "200000000",
    startTime: 1699800000,
    endTime: 1699900000,
    cancelable: false,
    status: "Completed" as const,
  },
];

const meta: Meta<typeof StreamDashboardView> = {
  title: "Composites/StreamDashboardView",
  component: StreamDashboardView,
};

export default meta;
type Story = StoryObj<typeof StreamDashboardView>;

// 1. Disconnected / Loading Freighter state
export const Disconnected: Story = {
  args: {
    address: null,
    streams: [],
  },
};

// 2. Connected state with loaded streams
export const Connected: Story = {
  args: {
    address: "GDHKQY6...SENDER1",
    streams: mockStreams,
    lookupId: "",
    lookupLoading: false,
  },
};

// 3. Connected state with empty stream list
export const ConnectedEmpty: Story = {
  args: {
    address: "GDHKQY6...SENDER1",
    streams: [],
    lookupId: "",
    lookupLoading: false,
  },
};

// 4. Lookup loading state
export const LookupLoading: Story = {
  args: {
    address: "GDHKQY6...SENDER1",
    streams: mockStreams,
    lookupId: "42",
    lookupLoading: true,
  },
};
