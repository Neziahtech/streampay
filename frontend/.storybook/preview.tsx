import type { Preview } from "@storybook/react";
import FakeTimers from "@sinonjs/fake-timers";
import "../app/globals.css";

// Baseline deterministic timestamp: 2023-11-14T22:13:20.000Z (epoch 1700000000)
export const DEFAULT_FIXED_TIME = 1700000000000;

let clock: FakeTimers.InstalledClock | null = null;

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    clock: {
      fixedTime: DEFAULT_FIXED_TIME,
    },
  },
  decorators: [
    (Story, context) => {
      // Uninstall previous clock instance if any
      if (clock) {
        clock.uninstall();
        clock = null;
      }

      // Inject deterministic fake timers to eliminate live accrual jitter in snapshots
      const fixedTime =
        context.parameters?.clock?.fixedTime ?? DEFAULT_FIXED_TIME;

      clock = FakeTimers.install({
        now: fixedTime,
        toFake: [
          "Date",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ],
      });

      return (
        <div
          style={{
            minHeight: "100vh",
            background: "var(--bg, #0b0f19)",
            color: "var(--text, #e2e8f0)",
            padding: "20px",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <Story />
        </div>
      );
    },
  ],
};

export default preview;
