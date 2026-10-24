import type { Meta, StoryObj } from "@storybook/react";
import AddressExplorerClient from "./AddressExplorerClient";

const mockExplorerStreams = [
  {
    id: "101",
    sender: "GDHKQY6W4Y3V5O2S46UFXG6W6P4N7FGLG5VNYF7K5S57D",
    recipient: "GBV4TNKH2S3U7V8X5J4E2W6T9R8F4L1M7N6P3Q2R1S",
    token: "native",
    deposit: "500000000",
    withdrawn: "150000000",
    startTime: 1699900000,
    endTime: 1700100000,
    cancelable: true,
    status: "Active" as const,
  },
  {
    id: "102",
    sender: "GA7QYNFH9P4T6L2S5K3J8W7R1M4E5V6T8N2Q1S3R4F",
    recipient: "GDHKQY6W4Y3V5O2S46UFXG6W6P4N7FGLG5VNYF7K5S57D",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    deposit: "250000000",
    withdrawn: "250000000",
    startTime: 1699500000,
    endTime: 1699800000,
    cancelable: false,
    status: "Completed" as const,
  },
];

const mockStats = {
  totalStreams: 2,
  activeStreams: 1,
  totalDeposited: 750000000n,
  totalWithdrawn: 400000000n,
};

const meta: Meta<typeof AddressExplorerClient> = {
  title: "Composites/AddressExplorerClient",
  component: AddressExplorerClient,
  args: {
    address: "GDHKQY6W4Y3V5O2S46UFXG6W6P4N7FGLG5VNYF7K5S57D",
    asOfTimestamp: 1700000000,
    tab: "all",
    status: "all",
    nextCursor: null,
    prevCursor: null,
    hasMore: false,
    hasPrev: false,
    totalMatching: 2,
    stats: mockStats,
  },
};

export default meta;
type Story = StoryObj<typeof AddressExplorerClient>;

// 1. Populated / Connected view
export const ConnectedPopulated: Story = {
  args: {
    streams: mockExplorerStreams,
  },
};

// 2. Empty state
export const Empty: Story = {
  args: {
    streams: [],
    totalMatching: 0,
    stats: {
      totalStreams: 0,
      activeStreams: 0,
      totalDeposited: 0n,
      totalWithdrawn: 0n,
    },
  },
};

// 3. Filtered: Active only
export const FilteredActive: Story = {
  args: {
    streams: [mockExplorerStreams[0]],
    status: "active",
    totalMatching: 1,
  },
};

// 4. Filtered: Ended / Completed only
export const FilteredEnded: Story = {
  args: {
    streams: [mockExplorerStreams[1]],
    status: "ended",
    totalMatching: 1,
  },
};

// 5. Pagination active
export const WithPagination: Story = {
  args: {
    streams: [mockExplorerStreams[0]],
    hasMore: true,
    hasPrev: true,
    nextCursor: "100",
    prevCursor: "102",
  },
};
