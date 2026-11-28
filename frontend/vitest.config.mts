import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Pure suites run in Node; component suites opt into jsdom per file.
// Vitest owns `.spec.ts`/`.spec.tsx`, while `node --test` owns `*.test.ts`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.spec.ts", "tests/**/*.spec.ts", "components/**/*.spec.tsx"],
  },
});
