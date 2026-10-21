#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../storybook-static/index.json");

// The 8 components and composites documented in docs/STORYBOOK.md that must be covered
export const REQUIRED_COMPONENTS = [
  "StreamDetailView",
  "StreamDashboardView",
  "AddressExplorerClient",
  "AccrualSimulator",
  "StreamList",
  "StreamForm",
  "BatchStreamForm",
  "ToastNotifications",
];

const MIN_TOTAL_STORIES = 8;

export function assertStoryCoverage(indexFilePath = indexPath) {
  if (!fs.existsSync(indexFilePath)) {
    throw new Error(
      `Storybook build artifact not found: ${indexFilePath}. Ensure 'storybook build' succeeded.`
    );
  }

  const raw = fs.readFileSync(indexFilePath, "utf-8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse Storybook index.json: ${err.message}`);
  }

  const entries = Object.values(data.entries || {});
  const storyEntries = entries.filter(
    (e) => !e.type || e.type === "story" || e.subtype === "story"
  );

  if (storyEntries.length < MIN_TOTAL_STORIES) {
    throw new Error(
      `Vacuous Storybook build detected: Found only ${storyEntries.length} stories, expected at least ${MIN_TOTAL_STORIES}.`
    );
  }

  const missingComponents = [];
  const coverageMap = {};

  for (const component of REQUIRED_COMPONENTS) {
    const matching = storyEntries.filter((s) => {
      const title = s.title || "";
      const importPath = s.importPath || "";
      return (
        title.toLowerCase().includes(component.toLowerCase()) ||
        importPath.toLowerCase().includes(component.toLowerCase())
      );
    });

    coverageMap[component] = matching.length;
    if (matching.length === 0) {
      missingComponents.push(component);
    }
  }

  if (missingComponents.length > 0) {
    throw new Error(
      `Storybook build failed coverage assertion: Missing stories for component(s): ${missingComponents.join(
        ", "
      )}.\nCoverage:\n${JSON.stringify(coverageMap, null, 2)}`
    );
  }

  console.log(
    `✓ Storybook coverage assertion passed: ${storyEntries.length} stories collected across all ${REQUIRED_COMPONENTS.length} claimed components.`
  );
  for (const [comp, count] of Object.entries(coverageMap)) {
    console.log(`  - ${comp}: ${count} story state(s)`);
  }

  return { totalStories: storyEntries.length, coverageMap };
}

// Run directly if invoked as script
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    assertStoryCoverage();
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }
}
