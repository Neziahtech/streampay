import type { Meta, StoryObj } from "@storybook/react";
import { ToastProvider } from "./toast";
import { createToastStore } from "../lib/toast";

const meta: Meta = {
  title: "Components/ToastNotifications",
  decorators: [
    (Story) => (
      <div style={{ height: "240px", position: "relative" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

export const Success: StoryObj = {
  render: () => {
    const store = createToastStore([
      {
        id: "toast-1",
        type: "success",
        message: "Stream #42 created successfully on-chain.",
        duration: 0,
      },
    ]);
    return (
      <ToastProvider store={store}>
        <div>Triggered Success Notification</div>
      </ToastProvider>
    );
  },
};

export const ErrorState: StoryObj = {
  render: () => {
    const store = createToastStore([
      {
        id: "toast-2",
        type: "error",
        message: "Wallet signature rejected: User declined transaction authorization.",
        duration: 0,
      },
    ]);
    return (
      <ToastProvider store={store}>
        <div>Triggered Error Notification</div>
      </ToastProvider>
    );
  },
};

export const MultiStacked: StoryObj = {
  render: () => {
    const store = createToastStore([
      {
        id: "toast-1",
        type: "info",
        message: "Discovered 3 streams on-chain.",
        duration: 0,
      },
      {
        id: "toast-2",
        type: "success",
        message: "Withdrew 1000 XLM from stream #12.",
        duration: 0,
      },
      {
        id: "toast-3",
        type: "error",
        message: "Simulation rate exceeded maximum token supply.",
        duration: 0,
      },
    ]);
    return (
      <ToastProvider store={store}>
        <div>Stacked Notifications Display</div>
      </ToastProvider>
    );
  },
};
