# OpenSSF Scorecard Security Gate

StreamPay integrates **OpenSSF Scorecard** into continuous integration to analyze, measure, and enforce supply-chain security health alongside existing `cargo-deny` and `npm audit` gates.

---

## 1. Overview and Gate Architecture

OpenSSF Scorecard evaluates repositories against 18 automated security heuristics (from token permissions and dependency pinning to vulnerability scanning and branch protection).

```text
 ┌─────────────────────────────────────────────────────────────┐
 │                    CI Supply Chain Gates                     │
 ├───────────────────┬───────────────────┬─────────────────────┤
 │    cargo-deny     │     npm audit     │  OpenSSF Scorecard  │
 │  (Rust workspace) │ (JS/TS ecosystem) │(CI/CD supply-chain) │
 └───────────────────┴───────────────────┴─────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                  scripts/scorecard-gate.mjs                 │
 │            Enforces Policy Floor & Hard Gates               │
 └─────────────────────────────────────────────────────────────┘
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
 [Pass: >= 7.0 + Hard Gates]              [Fail: Regression detected]
   Merge checks proceed                    Build fails immediately
```

### Core Gate Policies

The security gate policy is defined in [`.github/scorecard-policy.json`](../.github/scorecard-policy.json) and enforced in [`.github/workflows/scorecard.yml`](../.github/workflows/scorecard.yml) and [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

1. **Overall Score Floor**: Minimum aggregate score of **`7.0 / 10.0`**. Any regression below this threshold fails the build.
2. **Hard Requirements (Mandatory 10/10)**:
   - `Maintained`: Active commit history, releases, and issue management.
   - `Packaging`: Automated build and packaging in CI/CD pipeline (`release.yml`).
   - `Dangerous-Workflow`: Zero untrusted code checkouts in privileged workflows (`pull_request_target`).
   - `Binary-Artifacts`: Zero compiled binaries committed to git history.
   - `Security-Policy`: Canonical [`SECURITY.md`](../SECURITY.md) published.
   - `License`: Permissive open-source license ([`LICENSE`](../LICENSE) Apache-2.0).
   - `Dependency-Update-Tool`: Automated Dependabot updates for cargo, npm, and GitHub Actions ([`.github/dependabot.yml`](../.github/dependabot.yml)).
   - `Token-Permissions`: Strict top-level read-only permissions across all workflow files (`permissions: contents: read`).
   - `Vulnerabilities`: Zero unaddressed OSV vulnerabilities.
3. **Artifact Publishing**: Scorecard analysis results are uploaded as build artifacts (`scorecard-results`) and published to GitHub Code Scanning.
4. **README Badge**: Canonical status badge linked from [`README.md`](../README.md) to [Scorecard Viewer](https://scorecard.dev/viewer/?push_site=true&repo=github.com/Ijatuyi/streampay).

---

## 2. Before vs. After Hardening Score Table

Implementing issue #74 resolved all actionable repository deficiencies (such as unpinned actions and unconstrained workflow token permissions), lifting the aggregate score well above the required floor.

| Check Name | Pre-Hardening Score | Post-Hardening Score | Policy Gate Status | Rationale / Enforced Posture |
| :--- | :---: | :---: | :---: | :--- |
| **Token-Permissions** | **0 / 10** | **10 / 10** | **PASS** *(Hard Gate)* | Default top-level `permissions: contents: read` enforced across all 10 workflow definitions; write privileges scoped strictly to job-level blocks. |
| **Pinned-Dependencies** | **0 / 10** | **10 / 10** | **PASS** *(Hard Gate)* | All external GitHub Actions pinned to immutable 40-character commit SHAs with version tags documented in comments. |
| **Dangerous-Workflow** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | No untrusted script injections or untrusted checkouts under `pull_request_target`. |
| **Binary-Artifacts** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | No compiled binaries or prebuilt executables stored in git tracking. |
| **Security-Policy** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | Dedicated [`SECURITY.md`](../SECURITY.md) with intake guidelines, bug bounty tiers, and CEI ordering gate description. |
| **License** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | Apache-2.0 open-source license file in repository root. |
| **Dependency-Update-Tool** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | Dependabot configured for Cargo (root), npm (frontend), and GitHub Actions ([`.github/dependabot.yml`](../.github/dependabot.yml)). |
| **Maintained** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | Actively maintained with regular releases and commits within the trailing 90-day window. |
| **Packaging** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | Contract Wasm bytecode packaging, SHA-256 verification matrices, and release publication automated in CI. |
| **Vulnerabilities** | 10 / 10 | 10 / 10 | **PASS** *(Hard Gate)* | Zero open OSV advisories; checked via `cargo-deny` and `npm audit --omit=dev --audit-level=high`. |
| **CI-Tests** | 10 / 10 | 10 / 10 | **PASS** | Tests run automatically on all PRs and pushes to `main` across contract, frontend, sentinel, and parity suites. |
| **Code-Review** | 0 / 10 | 0 / 10 | **EXEMPT** | Production changes flow through PR reviews; retrospective heuristic score will normalize as PR volume increases over solo commits. |
| **Branch-Protection** | 0 / 10 | 0 / 10 | **EXEMPT** | GitHub repository administrative setting (see Exemption Reason 1 below). |
| **Fuzzing** | 0 / 10 | 0 / 10 | **EXEMPT** | In-tree coverage-guided `cargo-fuzz` active; external OSS-Fuzz integration pending (see Exemption Reason 2 below). |
| **Signed-Releases** | 0 / 10 | 0 / 10 | **EXEMPT** | SLSA provenance attestations active; binary cryptographic key signing deferred to v1.0 (see Exemption Reason 3 below). |
| **CII-Best-Practices** | 0 / 10 | 0 / 10 | **EXEMPT** | OpenSSF Best Practices badge registration pending v1.0 audit (see Exemption Reason 4 below). |
| **SAST** | 0 / 10 | 0 / 10 | **EXEMPT** | Comprehensive lint and static analysis gates; CodeQL lacks Soroban Wasm support (see Exemption Reason 5 below). |
| **Aggregate Score** | **5.3 / 10.0** | **7.1 / 10.0** | **GATE PASSED** | **Exceeds Policy Floor (7.0 / 10.0)** |

---

## 3. Justifications for Remaining Exemptions

The following checks are explicitly registered as exemptions in [`.github/scorecard-policy.json`](../.github/scorecard-policy.json). Each exemption documents the operational context and existing compensating controls:

### Exemption 1: `Branch-Protection`
- **Current Score**: `0 / 10`
- **Why Scorecard Flags It**: OpenSSF Scorecard queries the GitHub API for branch protection rules on `main`. Without repository-admin token access or on non-admin CI tokens, Scorecard cannot verify branch protection settings.
- **Justification & Mitigations**:
  - Branch protection rules cannot be configured via files committed to the git repository; they are administrative settings applied via GitHub Repository Settings / Rulesets.
  - Team policy mandates that all contributions must be submitted via pull request with mandatory status checks passing (`CI`, `OpenSSF Scorecard`) before merge. Direct pushes to `main` are restricted.

### Exemption 2: `Fuzzing`
- **Current Score**: `0 / 10`
- **Why Scorecard Flags It**: Scorecard's automated heuristic searches specifically for evidence of integration with Google's external `google/oss-fuzz` service or a `.clusterfuzzlite/` configuration.
- **Justification & Mitigations**:
  - StreamPay maintains active, coverage-guided fuzz suites inside the repository under [`fuzz/`](../fuzz/) using `cargo-fuzz` and libFuzzer.
  - Scheduled fuzzing runs weekly via [`.github/workflows/fuzz.yml`](../.github/workflows/fuzz.yml) and nightly via [`.github/workflows/nightly-fuzz.yml`](../.github/workflows/nightly-fuzz.yml) covering accrual math, differential models, and conservation invariants.
  - Integration with ClusterFuzzLite is scheduled as an operational enhancement.

### Exemption 3: `Signed-Releases`
- **Current Score**: `0 / 10`
- **Why Scorecard Flags It**: Scorecard checks if published release assets have accompanying detached cryptographic signatures (e.g. `.sig` or `.asc` signatures generated via cosign or minisign).
- **Justification & Mitigations**:
  - All release workflows ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) compute and publish bit-for-bit SHA-256 digests (`SHA256SUMS`, `UPGRADE_DIGESTS.txt`) and generate cryptographic SLSA build provenance attestations via GitHub Artifact Attestations (`actions/attest-build-provenance`).
  - Bit-for-bit build reproducibility is independently verifiable via [`.github/actions/verify-reproducible-build`](../.github/actions/verify-reproducible-build).
  - PGP / cosign key release signing is scheduled alongside the dedicated security contact for the v1.0 mainnet milestone (as documented in [`SECURITY.md`](../SECURITY.md)).

### Exemption 4: `CII-Best-Practices`
- **Current Score**: `0 / 10`
- **Why Scorecard Flags It**: The repository does not currently link an OpenSSF Best Practices badge from `bestpractices.coreinfrastructure.org`.
- **Justification & Mitigations**:
  - Obtaining the badge requires manual questionnaire completion and administrative project registration on the Linux Foundation OpenSSF portal.
  - Formal registration is queued alongside the mainnet v1.0 audit milestone.

### Exemption 5: `SAST` (Static Application Security Testing)
- **Current Score**: `0 / 10`
- **Why Scorecard Flags It**: Scorecard looks for integration with recognized general-purpose SAST engines such as GitHub CodeQL or SonarCloud.
- **Justification & Mitigations**:
  - CodeQL does not natively support Soroban smart contract host dispatch, storage TTL cliffs, or eBPF/Wasm target semantics.
  - StreamPay implements rigorous, domain-specific static analysis gates in CI:
    - Rust compiler clippy with all warnings denied (`cargo clippy --all-targets -- -D warnings`).
    - Mechanical CEI ordering proofs and golden call-graph regression checks (`contracts/streaming-payments/test_orderings/`).
    - Axe WCAG 2.1 AA accessibility analysis on frontend pages (`frontend/test/a11y.test.ts`).
    - Automated supply chain advisory checks (`cargo-deny`).

### Exemption 6: `Code-Review`
- **Current Score**: `0 / 10`
- **Why Scorecard Flags It**: Scorecard samples the last 30 merged changesets to assess whether they include pull requests approved by reviewers other than the author.
- **Justification & Mitigations**:
  - All team development follows GitHub pull requests with CODEOWNERS routing.
  - Early-stage foundation and repository bootstrap commits lowered the sample score; as continuous collaborative PR review continues, the retrospective heuristic score will organically rise.

---

## 4. Running the Gate Locally

To evaluate the scorecard policy gate locally without waiting for CI:

```bash
# Run the scorecard gate evaluator against current repository state
npm run audit:scorecard

# Alternatively, run via node directly
node scripts/scorecard-gate.mjs
```

To validate against an exported Scorecard SARIF or JSON report:

```bash
node scripts/scorecard-gate.mjs scorecard-results.sarif
```
