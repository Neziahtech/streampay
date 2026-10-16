import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./visual-tests",
  snapshotPathTemplate: "{testDir}/__snapshots__/{arg}{ext}",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.05,
      animations: "disabled",
    },
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.STORYBOOK_URL || "http://localhost:6006",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.CI ? {} : { channel: "chrome" }),
      },
    },
  ],
  webServer: {
    command: "npx serve -s storybook-static -l 6006 --no-clipboard",
    port: 6006,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
