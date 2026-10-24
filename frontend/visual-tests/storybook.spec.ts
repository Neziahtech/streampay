import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

// Deterministic baseline timestamp matching .storybook/preview.tsx
const DETERMINISTIC_TIMESTAMP = 1700000000000;

interface StoryEntry {
  id: string;
  title: string;
  name: string;
}

const indexPath = path.resolve(process.cwd(), "storybook-static/index.json");
let storyEntries: StoryEntry[] = [];

if (fs.existsSync(indexPath)) {
  const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  storyEntries = Object.values(data.entries || {});
}

test.describe("Storybook Visual Regression", () => {
  for (const story of storyEntries) {
    test(`Visual: ${story.title} - ${story.name}`, async ({ page }) => {
      // 1. Inject deterministic fake timers to prevent live accrual clock drift
      await page.clock.install({ time: DETERMINISTIC_TIMESTAMP });

      // 2. Navigate to the isolated story iframe
      await page.goto(`/iframe.html?id=${story.id}&viewMode=story`, {
        waitUntil: "domcontentloaded",
      });

      // 3. Wait for network idle and all fonts to finish loading
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);

      // 4. Visual regression screenshot assertion against baseline
      await expect(page).toHaveScreenshot(`${story.id}.png`, {
        maxDiffPixelRatio: 0.05,
      });
    });
  }
});
