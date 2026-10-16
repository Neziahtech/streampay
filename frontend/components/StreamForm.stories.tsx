import type { Meta, StoryObj } from "@storybook/react";
import StreamForm from "./StreamForm";

const meta: Meta<typeof StreamForm> = {
  title: "Components/StreamForm",
  component: StreamForm,
  args: {
    onCreate: async () => {},
  },
};

export default meta;
type Story = StoryObj<typeof StreamForm>;

export const NativeXlm: Story = {};

export const ContractToken: Story = {
  play: async ({ canvasElement }) => {
    const select = canvasElement.querySelector("#asset") as HTMLSelectElement;
    if (select) {
      select.value = "contract";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  },
};
