# Component Documentation & Visual Regression Testing

StreamPay uses **Storybook** for interactive UI component documentation and **Playwright** for automated visual regression testing in CI. This setup ensures that UI contributors get fast, deterministic feedback instead of manual visual inspection.

---

## 1. Next.js 16 & React 19 Integration: Friction & Resolution

StreamPay's frontend runs on **Next.js 16** and **React 19**. Combining modern Next.js 16 and React 19 with Storybook introduces specific friction points that require deliberate configuration:

### Friction 1: React 19 Peer Dependency Resolution & React DOM Shim
* **Problem:** React 19 changes ref handling (native `ref` prop without `forwardRef`) and alters hydration internals. Older Storybook versions and Webpack plugins enforce peer dependencies on React 18 or fail with React 19's `react-dom/client` packaging.
* **Resolution:** 
  - Standardized on Storybook 10 (`storybook@^10.6.2`, `@storybook/nextjs@^10.6.2`, `@storybook/react@^10.6.2`), which provides native React 19 support.
  - `@storybook/react-dom-shim` transparently adapts React 19 root rendering without breaking Storybook's isolated preview iframe.
  - Kept Next.js 16 (`next@^16.4.0`) and React 19 (`react@^19.0.0`) pinned in `dependencies`.

### Friction 2: Next.js 16 Turbopack vs Storybook Webpack Builder
* **Problem:** Next 16 defaults to Turbopack for local app builds, whereas Storybook utilizes Webpack 5 via `@storybook/nextjs`. Next.js-specific modules (`next/link`, `next/navigation`, `next/font`, and CSS module imports) require appropriate shimming in Webpack.
* **Resolution:** 
  - Configured `@storybook/nextjs` framework preset in `.storybook/main.ts` with `staticDirs: ["../public"]`.
  - Presentation components (`StreamDetailView`, `StreamDashboardView`) decouple presentation JSX from server hooks like `useParams()` or direct Freighter window bindings, allowing pure component rendering in Storybook.

### Friction 3: ESLint v10 vs Build Output
* **Problem:** Running `eslint .` after `npm run build-storybook` caused ESLint to traverse `storybook-static/`, parsing hundreds of megabytes of minified Webpack chunks and failing with Babel buffer warnings.
* **Resolution:** 
  - Explicitly added `storybook-static/**` to `frontend/eslint.config.mjs` ignores.
  - Added `storybook-static/` to `.gitignore`.

---

## 2. Deterministic Clocks & Live Accrual Jitter Prevention

### The Problem
StreamPay streams continuously accrue tokens second-by-second. Components such as `StreamDetailView` and `AddressExplorerClient` update their state using `setInterval(() => Date.now(), 1000)`. In visual regression testing, snapshot diffs would fail non-deterministically due to:
- Changing elapsed timestamps.
- Live token balance incrementing during rendering.
- Progress bar shifts.
- Locale/timezone formatting differences (`toLocaleString`).

### The Solution: Multi-Layered Injected Fake Timers
1. **Storybook Preview Decorator (`.storybook/preview.tsx`):**
   - Injects `@sinonjs/fake-timers` into every story.
   - Pinned to fixed epoch: `DEFAULT_FIXED_TIME = 1700000000000` (2023-11-14T22:13:20.000Z).
   - Overrides `Date`, `setTimeout`, `clearTimeout`, `setInterval`, and `clearInterval`.
   - Eliminates timer drift during story rendering. Stories can customize their baseline timestamp via `parameters.clock.fixedTime`.
2. **Playwright Browser Clock (`test/visual/storybook.spec.ts`):**
   - Playwright calls `page.clock.install({ time: 1700000000000 })` before loading the story iframe.
   - Pins viewport to `1280x800`, locale to `en-US`, and timezone to `UTC` in `playwright.visual.config.ts`.
   - Awaits `document.fonts.ready` and `networkidle` prior to screenshot capture.

This dual-layer deterministic clock guarantees identical screenshot hashes across local machines and CI runners.

---

## 3. Story Coverage: Per-State Stories

Every component and composite includes dedicated stories covering all required states:

| Component / Composite | Type | States Documented |
|---|---|---|
| **`StreamDetailView`** | Composite | `Loading`, `ErrorState`, `ConnectedRecipient`, `ConnectedSender`, `ReadOnly`, `OverWithdrawalError` |
| **`StreamDashboardView`** | Composite | `Disconnected`, `Connected`, `ConnectedEmpty`, `LookupLoading` |
| **`AddressExplorerClient`**| Composite | `ConnectedPopulated`, `Empty`, `FilteredActive`, `FilteredEnded`, `WithPagination` |
| **`AccrualSimulator`** | Composite | `DefaultInteractive` (linear, cliff, multi-segment) |
| **`StreamList`** | Component | `Empty`, `ActiveStreams` |
| **`StreamForm`** | Component | `NativeXlm`, `ContractToken` |
| **`BatchStreamForm`** | Component | `Empty`, `FilledExample` |
| **`ToastNotifications`** | Component | `Success`, `ErrorState`, `MultiStacked` |

---

## 4. CI Workflow Integration

In `.github/workflows/ci.yml`, the `visual-regression` job executes on every PR and push to `main`:

```yaml
visual-regression:
  name: Visual Regression — Storybook + Playwright
  runs-on: ubuntu-latest
  defaults:
    run:
      working-directory: frontend
  steps:
    - uses: actions/checkout@v7
    - uses: actions/setup-node@v7
      with:
        node-version: 22
        cache: npm
        cache-dependency-path: frontend/package-lock.json
    - name: Install dependencies
      run: npm ci
    - name: Build Storybook
      run: npm run build-storybook
    - name: Install Playwright browsers
      run: npx playwright install --with-deps chromium
    - name: Run visual regression tests
      run: npm run test:visual
    - name: Upload screenshot diffs on failure
      if: failure()
      uses: actions/upload-artifact@v4
      with:
        name: visual-regression-diffs
        path: |
          frontend/test-results/
          frontend/playwright-report/
        retention-days: 14
```

When a snapshot diff is detected:
- The job fails and uploads `visual-regression-diffs` containing:
  - `-diff.png` (highlighting pixel differences)
  - `-actual.png` (what was rendered)
  - `-expected.png` (baseline snapshot)
  - Playwright HTML report

---

## 5. Developer Commands

From the `frontend/` directory (or workspace root):

| Action | Frontend Script | Root Script |
|---|---|---|
| Run Storybook dev server | `npm run storybook` | `npm run storybook` |
| Build static Storybook | `npm run build-storybook` | `npm run build:storybook` |
| Run visual regression tests | `npm run test:visual` | `npm run test:visual` |
| Update baseline snapshots | `npm run test:visual:update` | — |
