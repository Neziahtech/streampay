import fs from "fs";
import path from "path";
import { test as baseTest, expect } from "@playwright/test";
import { setupSandbox, type SandboxContext } from "./sandbox";
import { createDeterministicSigner, type DeterministicSigner } from "./signer";
import { SeededStreamsManager } from "./seeded-streams";

export { expect };

export interface ExtendedFixtures {
  sandbox: SandboxContext;
  signer: DeterministicSigner;
  streams: SeededStreamsManager;
  networkLogs: any[];
}

export const test = baseTest.extend<ExtendedFixtures>({
  sandbox: async ({}, use) => {
    const sandbox = await setupSandbox();
    await use(sandbox);
    await sandbox.teardown();
  },

  signer: async ({ page, sandbox }, use) => {
    const signer = createDeterministicSigner(
      "sender",
      sandbox.networkPassphrase,
      sandbox.rpcUrl
    );
    await signer.setupBypass(page, sandbox.networkPassphrase, sandbox.rpcUrl);
    await use(signer);
  },

  streams: async ({ sandbox }, use) => {
    const manager = new SeededStreamsManager(sandbox);
    await use(manager);
  },

  networkLogs: async ({ page }, use, testInfo) => {
    const logs: any[] = [];

    page.on("request", (req) => {
      logs.push({
        timestamp: new Date().toISOString(),
        type: "request",
        data: {
          method: req.method(),
          url: req.url(),
          headers: req.headers(),
          postData: req.postData(),
        },
      });
    });

    page.on("response", async (res) => {
      let bodyText = "";
      try {
        if (
          res.url().includes("/rpc") ||
          res.headers()["content-type"]?.includes("json")
        ) {
          bodyText = await res.text();
        }
      } catch {}
      logs.push({
        timestamp: new Date().toISOString(),
        type: "response",
        data: {
          status: res.status(),
          url: res.url(),
          body: bodyText,
        },
      });
    });

    page.on("console", (msg) => {
      console.log(`[PAGE LOG ${msg.type()}] ${msg.text()}`);
      logs.push({
        timestamp: new Date().toISOString(),
        type: "console",
        data: {
          type: msg.type(),
          text: msg.text(),
        },
      });
    });

    page.on("pageerror", (err) => {
      console.log(`[PAGE ERROR] ${err.message}`);
    });

    page.on("pageerror", (err) => {
      logs.push({
        timestamp: new Date().toISOString(),
        type: "pageerror",
        data: {
          message: err.message,
          stack: err.stack,
        },
      });
    });

    await use(logs);

    // Save network & console log artifact on failure
    if (testInfo.status !== testInfo.expectedStatus) {
      const artifactDir = testInfo.outputDir;
      try {
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(
          path.join(artifactDir, "network-log.json"),
          JSON.stringify(logs, null, 2)
        );
      } catch (err) {
        console.error("Failed to write network logs artifact:", err);
      }
    }
  },
});
