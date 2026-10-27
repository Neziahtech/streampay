/**
 * Self-tests for the visual gate. A screenshot comparison that cannot fail is
 * green forever, and a story that only looks stable because nothing moved
 * proves nothing about the clock — so both properties are checked directly:
 *
 *  1. A real one-line stylesheet regression fails the comparison against the
 *     committed baseline (and leaves expected / actual / diff images in
 *     test-results/, which CI uploads — the demo diff).
 *  2. The live-accrual counter is frozen by the injected clock: two captures
 *     seconds apart are byte-identical, and advancing the fake clock changes
 *     the render (so (1)'s stability is not an accident of a static page).
 */

import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { renderStory } from "./storybook";

/** The regression: someone "tightens" the status pills in app/globals.css. */
const STATUS_BADGE_REGRESSION = `.status-badge { padding: 0.1rem 0.4rem; }`;
const REGRESSION_STORY = "streams-streamlist--populated";

const LIVE_STORY = "pages-streamdetail--connected-recipient";

test.describe("visual gate self-test", () => {
  test("a one-line CSS regression fails the screenshot comparison", async ({ page }, testInfo) => {
    const name = `${REGRESSION_STORY}.png`;
    const baseline = testInfo.snapshotPath(name, { kind: "screenshot" });

    // Updating baselines must never record the deliberately broken render.
    test.skip(
      testInfo.config.updateSnapshots === "all" || testInfo.config.updateSnapshots === "changed",
      "baseline update run: the regressed render must not become the baseline"
    );
    // Without a baseline toHaveScreenshot would *write* the regressed render.
    expect(fs.existsSync(baseline), `no baseline at ${baseline} to compare against`).toBe(true);

    await renderStory(page, REGRESSION_STORY);
    await page.addStyleTag({ content: STATUS_BADGE_REGRESSION });

    const failure = await expect(page)
      .toHaveScreenshot(name, { fullPage: true, timeout: 5_000 })
      .then(
        () => null,
        (error: Error) => error
      );

    expect(failure, "the visual gate accepted a changed stylesheet").not.toBeNull();
    expect(failure?.message).toMatch(/pixels? .*different|Screenshot comparison failed/i);
  });

  test("the injected clock freezes the live-accrual counter", async ({ page }) => {
    await renderStory(page, LIVE_STORY);
    const counter = page.getByLabel(/^Available balance:/);

    const first = await page.screenshot({ fullPage: true, animations: "disabled" });
    const before = await counter.textContent();
    // The engine's local ticker fires every second; let it fire a few times.
    await page.waitForTimeout(2_500);
    const second = await page.screenshot({ fullPage: true, animations: "disabled" });

    expect(await counter.textContent()).toBe(before);
    expect(Buffer.compare(first, second), "render drifted while the clock was frozen").toBe(0);

    // Positive control: the counter is clock-driven, so moving the fake clock
    // a minute forward must move it on the next tick.
    await page.evaluate(() => {
      const host = globalThis as unknown as {
        __STREAMPAY_FAKE_CLOCK__?: { tick(ms: number): void };
      };
      host.__STREAMPAY_FAKE_CLOCK__?.tick(60_000);
    });
    await expect(counter).not.toHaveText(before ?? "", { timeout: 5_000 });
  });
});
