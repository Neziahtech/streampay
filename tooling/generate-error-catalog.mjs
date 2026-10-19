#!/usr/bin/env node
/**
 * Error Catalog & Client Mapping Generator (Issue #221)
 *
 * Generates:
 *   - docs/errors.md (authoritative index catalog with version stamp)
 *   - docs/errors/{code}.md (individual detailed pages with remediation & cross-links)
 *   - frontend/lib/errors.ts (full 1..N client mapping with describeError fallback)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ERRORS_RS = resolve(ROOT, 'contracts/streaming-payments/src/errors.rs');
const SURFACE_RS = resolve(ROOT, 'contracts/streaming-payments/src/surface.rs');

const errorsContent = readFileSync(ERRORS_RS, 'utf8');
const surfaceContent = readFileSync(SURFACE_RS, 'utf8');

// Deterministic schema fingerprint: derived from the catalog's actual source
// content, NOT from HEAD or the environment. The CI regeneration-diff gate
// (`node tooling/generate-error-catalog.mjs && git diff --exit-code ...`)
// requires that regenerating the same tree always reproduces byte-identical
// output, so nothing volatile (git sha, timestamps) may appear in generated
// files. Line endings are normalized first: a contributor on Windows (CRLF
// working tree) and CI on Linux (LF) must compute the same fingerprint.
const norm = (s) => s.replace(/\r\n/g, '\n');
const schemaFingerprint = createHash('sha256')
  .update(norm(errorsContent))
  .update(norm(surfaceContent))
  .digest('hex')
  .slice(0, 16);

// Parse enum StreamError variants
const variantRegex = /^\s*([A-Za-z0-9_]+)\s*=\s*(\d+),/gm;
const variants = [];
let match;
while ((match = variantRegex.exec(errorsContent)) !== null) {
  variants.push({
    name: match[1],
    code: parseInt(match[2], 10),
  });
}

// Curated authoritative remediations, client mappings and tests for StreamPay errors
const ERROR_METADATA = {
  1: {
    remediation: 'Verify the stream ID from your transaction history or recipient dashboard before retrying.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::stream_not_found',
  },
  2: {
    remediation: 'This role check is retired on-chain. Ensure caller owns or is authorized on the stream.',
    toastClass: 'warning',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/surface.rs::RETIRED_CODES',
  },
  3: {
    remediation: 'This role check is retired on-chain. Ensure caller is the registered stream recipient.',
    toastClass: 'warning',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/surface.rs::RETIRED_CODES',
  },
  4: {
    remediation: 'This stream was created without cancelable permissions; funds stream until duration ends.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::cancel_stream_not_cancellable',
  },
  5: {
    remediation: 'The stream has already completed or been cancelled. No further mutations can be performed.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::stream_not_active',
  },
  6: {
    remediation: 'Choose a start timestamp at or after the current ledger close time.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::create_start_time_in_past',
  },
  7: {
    remediation: 'Ensure end time is strictly greater than start time by at least 1 second.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::create_invalid_time_range',
  },
  8: {
    remediation: 'Stream duration exceeds protocol maximum (10 years). Decrease stream duration.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::create_duration_too_long',
  },
  9: {
    remediation: 'Amount must be greater than zero. Enter a positive token amount.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::create_deposit_non_positive',
  },
  10: {
    remediation: 'Requested withdrawal exceeds available accrued balance. Check accrued amount or use withdraw max.',
    toastClass: 'warning',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::withdraw_amount_exceeds_available',
  },
  11: {
    remediation: 'Calculation overflowed arithmetic bounds. Reduce deposit amount or duration scale.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::capacity_overflow',
  },
  12: {
    remediation: 'Sign transaction with the sender, recipient, or designated governor account required for this call.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::cancel_stream_not_authorized',
  },
  13: {
    remediation: 'Zero unwithdrawn accrued funds available at current ledger timestamp. Wait for more funds to accrue.',
    toastClass: 'info',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::withdraw_max_nothing_to_withdraw',
  },
  14: {
    remediation: 'Protocol fee rate exceeds MAX_FEE_BPS (1,000 bps = 10%). Provide rate at or below cap.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::set_fee_rate_too_high',
  },
  15: {
    remediation: 'Caller is not the active treasury governor. Switch to authorized governor wallet.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::governor_not_allowed',
  },
  16: {
    remediation: 'No governor nomination is pending. Request current governor to nominate address first.',
    toastClass: 'warning',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::accept_governor_no_pending',
  },
  17: {
    remediation: 'Treasury withdrawal amount exceeds collected protocol fees for this asset token.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::withdraw_treasury_exceeds_balance',
  },
  18: {
    remediation: 'Intent ID not found. Verify scheduled intent reference before retrying.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::intent_not_found',
  },
  19: {
    remediation: 'Scheduled intent is already executed, cancelled, or expired.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::intent_not_pending',
  },
  20: {
    remediation: 'Current ledger timestamp has not reached execute_after time. Wait for scheduled window.',
    toastClass: 'info',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::intent_not_yet_executable',
  },
  21: {
    remediation: 'Intent has passed expires_at deadline. Reclaim deposited funds via reclaim_expired.',
    toastClass: 'warning',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::intent_expired',
  },
  22: {
    remediation: 'Execution window has already opened; scheduled intent can no longer be cancelled.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::intent_not_cancellable',
  },
  23: {
    remediation: 'Check occurrence count, interval spacing, and expiration ordering in schedule parameters.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::invalid_schedule_parameters',
  },
  24: {
    remediation: 'Stored intent parameters do not match initial hash commitment. Contact security oncall.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::intent_params_mismatch',
  },
  25: {
    remediation: 'Cannot reclaim intent funds before expires_at timestamp has passed.',
    toastClass: 'warning',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::intent_not_expired',
  },
  26: {
    remediation: 'Token pull failed on stream creation. Check account balance and token allowance for deposit + fee.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::deposit_transfer_failed',
  },
  27: {
    remediation: 'Token pull failed during top-up. Ensure sufficient token balance and trustline authorization.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::top_up_transfer_failed',
  },
  28: {
    remediation: 'Recipient token payout failed. Verify recipient address has a valid trustline and is authorized.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::recipient_payout_failed',
  },
  29: {
    remediation: 'Sender refund payout failed during cancellation. Check sender token account status.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::sender_refund_failed',
  },
  30: {
    remediation: 'Treasury payout transfer failed. Ensure destination treasury account accepts this token.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::treasury_payout_failed',
  },
  31: {
    remediation: 'Token asset is not on the governance policy allowlist. Propose asset addition via governor.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_asset_not_allowed',
  },
  32: {
    remediation: 'Policy change timelock has not elapsed. Wait until queued timelock expiry before applying.',
    toastClass: 'info',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_timelock_not_elapsed',
  },
  33: {
    remediation: 'No queued policy change found for this asset. Queue change proposal first.',
    toastClass: 'warning',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_no_queued_change',
  },
  34: {
    remediation: 'Policy module is uninitialized. Call initialize_policy with initial governor and parameters.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_not_initialized',
  },
  35: {
    remediation: 'No admin handoff proposal is pending. Request current admin to nominate successor.',
    toastClass: 'warning',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_no_pending_handoff',
  },
  36: {
    remediation: 'Contract is currently frozen for maintenance. Operations resume once unfrozen.',
    toastClass: 'warning',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::contract_frozen',
  },
  37: {
    remediation: 'This operation requires the contract to be frozen first.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::contract_not_frozen',
  },
  38: {
    remediation: 'No upgrade proposal is currently pending.',
    toastClass: 'warning',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::no_pending_upgrade',
  },
  39: {
    remediation: 'Upgrade timelock delay has not expired. Wait for delay to complete.',
    toastClass: 'info',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::timelock_not_expired',
  },
  40: {
    remediation: 'Proposed upgrade delay is shorter than minimum timelock. Increase proposed delay.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::upgrade_delay_too_short',
  },
  41: {
    remediation: 'Storage migration has already been executed on this contract instance.',
    toastClass: 'info',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::already_migrated',
  },
  42: {
    remediation: 'Stream payment rate is below governance policy floor. Increase flow rate.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_rate_below_floor',
  },
  43: {
    remediation: 'Stream payment rate exceeds governance policy ceiling. Decrease flow rate.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_rate_above_ceiling',
  },
  44: {
    remediation: 'Stream duration is shorter than minimum policy floor. Increase stream duration.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_duration_below_floor',
  },
  45: {
    remediation: 'Stream duration exceeds maximum policy ceiling. Decrease stream duration.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_duration_above_ceiling',
  },
  46: {
    remediation: 'Stream deposit is below governance policy floor. Increase initial deposit amount.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::policy_deposit_below_floor',
  },
  56: {
    remediation: 'Oracle threshold is invalid. Threshold must be between 1 and the publisher count.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::invalid_oracle_threshold',
  },
  57: {
    remediation: 'Oracle publishers are not configured. Governor must set oracle config first.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::oracle_publishers_not_configured',
  },
  58: {
    remediation: 'Oracle report timestamp is too far in the past or future. Submit a fresh report.',
    toastClass: 'error',
    retryable: true,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::oracle_report_too_old',
  },
  59: {
    remediation: 'Caller is not an authorized oracle publisher.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs::not_oracle_publisher',
  },
};

// Ensure directories exist
mkdirSync(resolve(ROOT, 'docs/errors'), { recursive: true });

// 1. Generate individual docs/errors/{code}.md pages
for (const item of variants) {
  const meta = ERROR_METADATA[item.code] || {
    remediation: 'Contact protocol support if this error persists.',
    toastClass: 'error',
    retryable: false,
    testRef: 'contracts/streaming-payments/src/error_surface_test.rs',
  };

  const isRetired = item.code === 2 || item.code === 3;
  const status = isRetired ? 'Retired (Unreachable)' : 'Active (Enforced)';

  const pageContent = `# Error #${item.code}: ${item.name}

<!-- Generated by tooling/generate-error-catalog.mjs. Do not edit manually. -->

## Summary
- **Numeric Code**: \`#${item.code}\`
- **Variant Name**: \`${item.name}\`
- **Status**: ${status}
- **Client Toast Level**: \`${meta.toastClass.toUpperCase()}\`
- **Retryable**: \`${meta.retryable ? 'Yes' : 'No'}\`

---

## Trigger Conditions
This error is returned by the contract when:
- \`${item.name}\` validation fails during entrypoint invocation.
${isRetired ? '- *Note*: This code is reserved/retired on-chain to guarantee append-only numbering continuity.' : ''}

---

## User Remediation Guidance
> **Plain-Language Remediation**:  
> ${meta.remediation}

---

## Client-Side Mapping
\`\`\`json
{
  "code": ${item.code},
  "variant": "${item.name}",
  "toastClass": "${meta.toastClass}",
  "retryable": ${meta.retryable},
  "message": "${item.name} (#${item.code}): ${meta.remediation}"
}
\`\`\`

---

## Automated Verification & Cross-Links
- **Regression / Coverage Probe**: [\`${meta.testRef}\`](../../${meta.testRef})
- **Error Surface Registry**: [\`contracts/streaming-payments/src/surface.rs\`](../../contracts/streaming-payments/src/surface.rs)
- **Error Enum Definition**: [\`contracts/streaming-payments/src/errors.rs\`](../../contracts/streaming-payments/src/errors.rs)
`;

  writeFileSync(resolve(ROOT, `docs/errors/${item.code}.md`), pageContent, 'utf8');
}

// 2. Generate docs/errors.md (Master Index Catalog)
let indexMd = `<!-- Generated by tooling/generate-error-catalog.mjs. Do not edit by hand. -->
<!-- Version: schema_fingerprint=${schemaFingerprint} -->

# StreamPay On-Chain Error Code Catalog

Authoritative registry of all **${variants.length}** append-only on-chain error codes returned by the StreamPay Soroban smart contract.

## Release & Schema Version
- **Schema Fingerprint**: \`${schemaFingerprint}\`
- **Catalog Version Guarantee**: Append-only numeric code preservation (codes 1–${variants.length}).

---

## Error Code Registry Index

| Code | Variant Name | Status | Toast Level | Retryable | Remediation Guidance | Detail Page |
| ---: | --- | --- | --- | :---: | --- | :---: |
`;

for (const item of variants) {
  const meta = ERROR_METADATA[item.code] || {
    remediation: 'Contact protocol support if this error persists.',
    toastClass: 'error',
    retryable: false,
  };
  const isRetired = item.code === 2 || item.code === 3;
  const statusBadge = isRetired ? 'Retired' : 'Active';
  const retryBadge = meta.retryable ? 'Yes' : 'No';

  indexMd += `| **#${item.code}** | \`${item.name}\` | ${statusBadge} | \`${meta.toastClass}\` | ${retryBadge} | ${meta.remediation} | [View Docs](errors/${item.code}.md) |\n`;
}

indexMd += `\n---

## Client Error Handling Protocol

When the Soroban RPC returns an invocation rejection in the form:
\`\`\`text
Error(Contract, #${1})
\`\`\`

The client application intercepts and translates it using \`describeError\` from \`frontend/lib/errors.ts\`.

- **\`error\`**: Terminal or authorization failure requiring user input correction or different wallet.
- **\`warning\`**: Operational conflict or state mismatch (e.g. withdrawal exceeds accrued balance).
- **\`info\`**: Timelock or scheduling wait period (e.g. stream not yet due for execution).

---

## Maintenance & CI Invariants
1. **Append-Only**: Codes are never renumbered or deleted.
2. **Exhaustive Mapping**: Every variant in \`StreamError\` has a corresponding entry in this catalog and in \`frontend/lib/errors.ts\`.
3. **CI Gate**: CI runs \`node tooling/generate-error-catalog.mjs\` and verifies zero diff with git.
`;

writeFileSync(resolve(ROOT, 'docs/errors.md'), indexMd, 'utf8');

// 3. Generate frontend/lib/errors.ts
let tsCode = `// Generated by tooling/generate-error-catalog.mjs. Do not edit by hand.
// Version: schema_fingerprint=${schemaFingerprint}


export interface ErrorCatalogEntry {
  code: number;
  name: string;
  remediation: string;
  toastClass: 'error' | 'warning' | 'info';
  retryable: boolean;
}

export const ERROR_CATALOG: Record<number, ErrorCatalogEntry> = {
`;

for (const item of variants) {
  const meta = ERROR_METADATA[item.code] || {
    remediation: 'Contact protocol support if this error persists.',
    toastClass: 'error',
    retryable: false,
  };
  tsCode += `  ${item.code}: {
    code: ${item.code},
    name: "${item.name}",
    remediation: "${meta.remediation.replace(/"/g, '\\"')}",
    toastClass: "${meta.toastClass}",
    retryable: ${meta.retryable},
  },\n`;
}

tsCode += `};

export function getErrorDetails(err: unknown): ErrorCatalogEntry | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/Error\\(Contract, #(\\d+)\\)/);
  if (match) {
    const code = Number(match[1]);
    return ERROR_CATALOG[code] ?? null;
  }
  return null;
}

export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/Error\\(Contract, #(\\d+)\\)/);
  if (match) {
    const code = Number(match[1]);
    const entry = ERROR_CATALOG[code];
    if (entry) {
      return \`Contract rejected the call: \${entry.name} (#\${code}). \${entry.remediation}\`;
    }
    return \`Contract error #\${code}\`;
  }
  return message;
}
`;

writeFileSync(resolve(ROOT, 'frontend/lib/errors.ts'), tsCode, 'utf8');

console.log(`[Success] Generated catalog for ${variants.length} error codes:`);
console.log(`  - docs/errors.md`);
console.log(`  - docs/errors/*.md (${variants.length} files)`);
console.log(`  - frontend/lib/errors.ts`);
