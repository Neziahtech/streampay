import fs from "fs";
import path from "path";
import { defineConfig, devices } from "@playwright/test";

// Load frontend/.env.local if present so deployed sandbox contract ID takes precedence
const envLocalPath = path.resolve(__dirname, "frontend/.env.local");
if (fs.existsSync(envLocalPath)) {
  const content = fs.readFileSync(envLocalPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Single worker prevents on-chain account sequence collisions
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
    headless: true,
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
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
    command: "npm run dev",
    cwd: "./frontend",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "http://localhost:8000/rpc",
      NEXT_PUBLIC_NETWORK: "LOCAL",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Standalone Network ; February 2017",
      NEXT_PUBLIC_STREAMING_CONTRACT_ID: process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
  },
});
