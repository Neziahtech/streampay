# Key Compromise Incident Template

Copy this file to `docs/incidents/YYYY-MM-DD-key-compromise-<role>.md`, fill it
in, and keep it **confidential** until containment is done: work the incident
in a private channel and GitHub private vulnerability reporting (see
[`SECURITY.md`](../SECURITY.md)), not a public issue. The filled-in document
feeds the public postmortem via
[`docs/POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md) once the response is
complete.

For a *suspected* (not confirmed) compromise, run containment steps 1-4
anyway — a rotation on a healthy key is cheap; a missed rotation is not.

---

## Metadata

| Field | Value |
|---|---|
| Status | Open / Contained / Resolved |
| Date detected (UTC) | YYYY-MM-DD HH:MM |
| Role(s) suspected | governor / policy admin / treasury signer / deployer / TTL extender / webhook / session agent / other |
| Detected by | @handle / monitor / external report |
| Confidence | confirmed / suspected |
| Linked postmortem | #… |

## 1. Suspected exposure

- What happened (facts only, no theories yet):
- Where the key lived (env var name / host / password-manager item — never the secret):
- Earliest plausible exposure time:
- Every surface that key could touch (use [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) §4 and [`docs/OPERATIONS.md`](./OPERATIONS.md) §2.1 blast-radius column):
- For a session agent key: the affected `(recipient, agent, stream)` triples, current cap window state, and whether the agent key is still valid on-chain (`agent_cap` view):

## 2. Immediate containment (in order)

- [ ] **1. Freeze (only if the governor may be abused live):** `set_frozen true`
      via a key that is still trusted — see
      [`docs/rotation-runbook.md`](./rotation-runbook.md) °0. Record the ledger
      and the freeze window.
- [ ] **2. Stop the bleeding at the source:** revoke the leaked credential's
      carrier (rotate the CI secret, kill the host session, revoke the token)
      *before* rotating on-chain roles, so the new key is not exposed the same
      way.
- [ ] **3. Drain fund-bearing keys:** deployer and TTL extender keys hold XLM
      only — drain to a trusted address down to dust.
- [ ] **4. Assume active adversary:** any queued but unexecuted governance
      action proposed by the old key is hostile — inspect `pending_upgrade`,
      `policy_get_queued_asset`, and re-queue/cancel as needed.
- [ ] **5. Revoke the session agent (recipient-authorized caps):** call
      `revoke_agent(agent)` from the recipient account for every affected
      stream. Revocation takes effect immediately at the next ledger close and
      blocks all further `withdraw_delegated` calls for that `agent` on the
      affected streams. Record the revocation tx hash and ledge. Any window
      capacity already consumed by the attacker is bounded by the cap ledger and
      cannot be replayed after revocation.
- [ ] **6. Rotate the agent key out-of-band:** if the agent is still needed,
      generate a new keypair, re-authorize via `authorize_agent` with tighter
      caps, and do not re-use the compromised key.

## 3. Rotation (per role)

Work each affected role through [`docs/rotation-runbook.md`](./rotation-runbook.md),
then record evidence:

| Role | Rotated at (UTC) | Old address (public) | New address (public) | Verification evidence |
|---|---|---|---|---|
| Treasury governor |  |  |  | `treasury_status` read + drill matrix |
| Policy admin(s) |  |  |  | `policy_admin` read |
| Treasury signer set |  |  |  | Horizon signer list |
| Deployer / TTL extender / webhooks |  |  |  | workflow run / sentinel log |
| Session agent (per recipient/stream) |  |  |  | `agent_cap` read + `revoke_agent` tx hash |

## 4. Blast-radius assessment

- Could the key have authorized anything on-chain before containment? List
  every tx (RPC history by address) and classify: benign / governance /
  fund-moving.
- For a session agent: list every `withdraw_delegated` tx and the amount claimed
  per window. Confirm total claimed per window ≤ the configured cap, and that
  total claimed per stream ≤ the per-stream cap. Any excess is a contract
  bug — escalate immediately.
- Invariants to re-verify after containment (`SCURITY.md`): per-stream
  `0 ≤ withdrawn ≤ streamed ≤ deposit`; contract balance ≥ Σ(deposit −
  withdrawn); fee ledger reconciliation via `scripts/verify-fees.ts`.
- Data exposed beyond signing power (contract ids, webhook payloads, env
  dumps):

## 5. Timeline

All times UTC.

| Time | Event | Actor / tool |
|---|---|---|
| | Detected | |
| Frozen (if applicable) | |
| | Source revoked | |
| | Session agent revoked | |
| | Roles rotated | |
| | Invariants re-verified | |
| Unfrozen / service restored | |
| | Postmortem published | |

## 6. Prevention follow-ups

- [ ] Re-run the quarterly drill early (`.github/workflows/key-rotation-drill.yml`, workflow_dispatch) and attach the matrix.
- [ ] Update [`docs/SECURITY_LOG.md`](./SECURITY_LOG.md) with the rotation entry.
- [ ] Tighten session-key caps or shorten the cap window for the affected recipient(s).
- [ ] Fix the gap that exposed the key (process or tooling), filed as #…