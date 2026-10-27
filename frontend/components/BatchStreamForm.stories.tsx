import type { Meta, StoryObj } from "@storybook/react";
import BatchStreamForm from "./BatchStreamForm";

const meta: Meta<typeof BatchStreamForm> = {
  title: "Components/BatchStreamForm",
  component: BatchStreamForm,
  args: {
    onCreate: async () => true,
  },
};

export default meta;
type Story = StoryObj<typeof BatchStreamForm>;

export const Empty: Story = {};

export const FilledExample: Story = {
  play: async ({ canvasElement }) => {
    const tokenInput = canvasElement.querySelector("#batch-token") as HTMLInputElement;
    if (tokenInput) {
      tokenInput.value = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      tokenInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const csvInput = canvasElement.querySelector("#batch-csv") as HTMLTextAreaElement;
    if (csvInput) {
      csvInput.value = "address,rate,duration\nGBV4TNKH2S3U7V8X5J4E2W6T9R8F4L1M7N6P3Q2R1S,1000,2592000\nGA7QYNFH9P4T6L2S5K3J8W7R1M4E5V6T8N2Q1S3R4F,500,1296000";
      csvInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  },
};
