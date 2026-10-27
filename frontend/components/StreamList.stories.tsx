import type { Meta, StoryObj } from "@storybook/react";
import StreamList from "./StreamList";

const meta: Meta<typeof StreamList> = {
  title: "Components/StreamList",
  component: StreamList,
  args: {
    onWithdraw: async () => {},
    onWithdrawMax: async () => {},
    onTopUp: async () => {},
    onCancel: async () => {},
    onRefresh: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof StreamList>;

export const Empty: Story = {
  args: {
    streams: [],
  },
};

export const ActiveStreams: Story = {
  args: {
    streams: [
      {
        id: "101",
        sender: "GDHKQY6...SENDER1",
        recipient: "GBV4TNK...RECIPIENT1",
        token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        deposit: "50000000",
        withdrawn: "12500000",
        startTime: 1700000000,
        endTime: 1700086400,
        cancelable: true,
        status: "Active",
      },
      {
        id: "102",
        sender: "GDHKQY6...SENDER1",
        recipient: "GA7QYNF...RECIPIENT2",
        token: "native",
        deposit: "100000000",
        withdrawn: "100000000",
        startTime: 1700000000,
        endTime: 1700050000,
        cancelable: false,
        status: "Completed",
      },
    ],
  },
};
