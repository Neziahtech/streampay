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
 *     When (2) does fail it records what moved — the DOM mutations inside the
 *     window, the height and animation state each capture saw, and both PNGs —
 *     because a drift that cannot be explained cannot be fixed.
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

  test("the injected clock freezes the live-accrual counter", async ({ page }, testInfo) => {
    await renderStory(page, LIVE_STORY);
    const counter = page.getByLabel(/^Available balance:/);

    // Evidence capture, not a relaxation: the byte comparison below is exactly
    // as strict as it was. What it adds is the answer to *why* two captures of
    // a frozen clock can differ, because "Received: -1" on its own does not
    // say. Every DOM mutation inside the window is recorded (a remount shows up
    // as removed+added nodes, a ticking value as one characterData record, a
    // re-render that only touches attributes as an attribute record), along
    // with the document height each capture saw — `fullPage` output changes
    // size with the height, so a one-pixel layout shift rewrites the whole
    // image — and the animations still alive behind the pin. When the bytes
    // differ, both PNGs are attached to the report, which CI uploads as the
    // `visual-diffs` artifact, so the drift can be read pixel by pixel instead
    // of guessed at.
    await page.evaluate(() => {
      const host = globalThis as unknown as { __STREAMPAY_VISUAL_EVIDENCE__?: string[] };
      const log: string[] = [];
      host.__STREAMPAY_VISUAL_EVIDENCE__ = log;
      const t0 = performance.now();
      const label = (node: Node | null): string => {
        const el = node instanceof Element ? node : (node?.parentElement ?? null);
        if (!el) return "(detached)";
        const id = el.id ? `#${el.id}` : "";
        const classes = el.classList.length > 0 ? `.${[...el.classList].join(".")}` : "";
        return `${el.nodeName.toLowerCase()}${id}${classes}`;
      };
      const clip = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").slice(0, 60);
      new MutationObserver((records) => {
        for (const record of records) {
          if (log.length >= 200) return;
          const at = `+${Math.round(performance.now() - t0)}ms`;
          if (record.type === "childList") {
            const added = [...record.addedNodes].map(label).join(",");
            const removed = [...record.removedNodes].map(label).join(",");
            log.push(`${at} children of ${label(record.target)} removed[${removed}] added[${added}]`);
          } else if (record.type === "characterData") {
            log.push(`${at} text of ${label(record.target)} "${clip(record.oldValue)}" -> "${clip(record.target.nodeValue)}"`);
          } else {
            const el = record.target as Element;
            log.push(`${at} ${label(el)} @${record.attributeName} = "${clip(el.getAttribute(record.attributeName ?? ""))}" (was "${clip(record.oldValue)}")`);
          }
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeOldValue: true,
        characterDataOldValue: true,
      });
    });

    interface Capture {
      png: Buffer;
      height: number;
      animations: string[];
    }

    const capture = async (): Promise<Capture> => {
      const [png, height, animations] = await Promise.all([
        page.screenshot({ fullPage: true, animations: "disabled" }),
        page.evaluate(() => document.documentElement.scrollHeight),
        page.evaluate(() =>
          document.getAnimations().map((a) =>
            `${a instanceof CSSAnimation ? a.animationName : a.constructor.name}:${a.playState}`
          )
        ),
      ]);
      return { png, height, animations };
    };

    const first = await capture();
    const before = await counter.textContent();
    // The engine's local ticker fires every second; let it fire a few times.
    await page.waitForTimeout(2_500);
    const second = await capture();

    const mutations = await page.evaluate(
      () =>
        (globalThis as unknown as { __STREAMPAY_VISUAL_EVIDENCE__?: string[] })
          .__STREAMPAY_VISUAL_EVIDENCE__ ?? []
    );

    expect(await counter.textContent()).toBe(before);

    let evidence = "";
    const drift =
      `render drifted while the clock was frozen: ${first.png.length} vs ${second.png.length} bytes, ` +
      `scrollHeight ${first.height} -> ${second.height}, ` +
      `animations ${first.animations.join(",") || "none"} -> ${second.animations.join(",") || "none"}, ` +
      `${mutations.length} DOM mutations [${mutations.slice(0, 25).join(" ;; ").slice(0, 1_500)}]`;

    // Attaching by `body` rather than by `path`: the test's output directory is
    // not created until Playwright itself writes to it, so writing a file there
    // from the test body fails with ENOENT — and an evidence bug that throws
    // replaces the very failure the evidence exists to explain. So nothing
    // touches the filesystem, and the whole capture is wrapped anyway: if it
    // ever does go wrong the message says so and the assertion still runs.
    if (Buffer.compare(first.png, second.png) !== 0) {
      try {
        await Promise.all([
          testInfo.attach("drift-before", { body: first.png, contentType: "image/png" }),
          testInfo.attach("drift-after", { body: second.png, contentType: "image/png" }),
          testInfo.attach("drift-dom-mutations", {
            body: Buffer.from(
              [
                drift,
                `capture 1 animations: ${first.animations.join(", ") || "none"}`,
                `capture 2 animations: ${second.animations.join(", ") || "none"}`,
                ...mutations,
              ].join("\n"),
              "utf8"
            ),
            contentType: "text/plain",
          }),
        ]);
      } catch (e) {
        evidence = `evidence capture failed: ${String(e)}`;
      }
    }

    expect(Buffer.compare(first.png, second.png), [drift, evidence].filter(Boolean).join(" — ")).toBe(0);

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
