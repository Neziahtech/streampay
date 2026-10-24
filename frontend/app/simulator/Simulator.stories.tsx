import type { Meta, StoryObj } from "@storybook/react";
import SimulatorPage from "./page";

const meta: Meta<typeof SimulatorPage> = {
  title: "Composites/AccrualSimulator",
  component: SimulatorPage,
};

export default meta;
type Story = StoryObj<typeof SimulatorPage>;

export const DefaultInteractive: Story = {};
