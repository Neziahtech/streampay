import type Database from "better-sqlite3";
import type { Detection, Evidence, FeedbackLabel, RuleMode, Severity, TenantRuleOverride, WindowCitation } from "./types.js";

/** Namespaced row in `indexer_state` holding the incident table across restarts. */
export const INCIDENT_STATE_KEY = "anomaly.incidents";

export interface FeedbackRecord {
  id: string;
  detectionId: string;
  tenantId: string;
  label: FeedbackLabel;
  note: string | null;
  createdAtMs: number;
}

export interface AlertRecord {
  id: string;
  detectionId: string;
  incidentKey: string;
  tenantId: string;
  ruleId: string;
  type: "raised" | "resolved";
  severity: Severity;
  mode: RuleMode;
  routed: boolean;
  reason: string | null;
  atMs: number;
}

export interface SuppressionRecord {
  tenantId: string;
  ruleId: string;
  subjectKey: string;
  expiresAtMs: number;
  reason: string;
}

export interface FeedbackSummary {
  rule_id: string;
  tenant_id: string;
  detections: number;
  shadow_detections: number;
  enforce_detections: number;
  reviewed: number;
  true_positives: number;
  false_positives: number;
  /** Fraction of reviewed detections an operator called wrong. */
  false_positive_rate: number;
  suppressed_subjects: number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Durable side of the detector: detections and their citations, operator
 * feedback, per-tenant rule overrides, and the incident table the deduper
 * resumes from. Detection rows are what make an alert auditable after the
 * in-process windows have rolled on.
 */
export class AnomalyStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS anomaly_detections (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL,
        tenant_id TEXT NOT NULL, severity TEXT NOT NULL, mode TEXT NOT NULL,
        subject_key TEXT NOT NULL, citation TEXT NOT NULL, fingerprint TEXT NOT NULL,
        evidence TEXT NOT NULL, params TEXT NOT NULL, created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS anomaly_detections_tenant
        ON anomaly_detections(tenant_id, created_at_ms DESC, id);
      CREATE INDEX IF NOT EXISTS anomaly_detections_rule
        ON anomaly_detections(rule_id, tenant_id, created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS anomaly_rule_overrides (
        tenant_id TEXT NOT NULL, rule_id TEXT NOT NULL, config TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, rule_id)
      );

      CREATE TABLE IF NOT EXISTS anomaly_feedback (
        id TEXT PRIMARY KEY, detection_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        label TEXT NOT NULL, note TEXT, created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS anomaly_feedback_detection ON anomaly_feedback(detection_id);

      CREATE TABLE IF NOT EXISTS anomaly_suppressions (
        tenant_id TEXT NOT NULL, rule_id TEXT NOT NULL, subject_key TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY (tenant_id, rule_id, subject_key)
      );

      CREATE TABLE IF NOT EXISTS anomaly_alerts (
        id TEXT PRIMARY KEY, detection_id TEXT NOT NULL, incident_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL, rule_id TEXT NOT NULL, type TEXT NOT NULL,
        severity TEXT NOT NULL, mode TEXT NOT NULL, routed INTEGER NOT NULL,
        reason TEXT, at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS anomaly_alerts_tenant ON anomaly_alerts(tenant_id, at_ms DESC, id);
    `);
  }

  /** `INSERT OR IGNORE` on the fingerprint id: the same window re-derived is one detection. */
  recordDetection(detection: Detection): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO anomaly_detections
         (id, rule_id, rule_version, tenant_id, severity, mode, subject_key, citation, fingerprint, evidence, params, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        detection.id,
        detection.ruleId,
        detection.ruleVersion,
        detection.tenantId,
        detection.severity,
        detection.mode,
        detection.subjectKey,
        JSON.stringify(detection.citation),
        detection.fingerprint,
        JSON.stringify(detection.evidence),
        JSON.stringify(detection.params),
        detection.createdAtMs
      );
    return result.changes > 0;
  }

  getDetection(id: string): Detection | undefined {
    const row = this.db
      .prepare("SELECT * FROM anomaly_detections WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDetection(row) : undefined;
  }

  listDetections(options: { tenantId: string; ruleId?: string; mode?: RuleMode; limit?: number }): Detection[] {
    const clauses = ["tenant_id = @tenantId"];
    const params: Record<string, unknown> = { tenantId: options.tenantId, limit: options.limit ?? 50 };
    if (options.ruleId) {
      clauses.push("rule_id = @ruleId");
      params.ruleId = options.ruleId;
    }
    if (options.mode) {
      clauses.push("mode = @mode");
      params.mode = options.mode;
    }
    const rows = this.db
      .prepare(`SELECT * FROM anomaly_detections WHERE ${clauses.join(" AND ")} ORDER BY created_at_ms DESC, id ASC LIMIT @limit`)
      .all(params) as Record<string, unknown>[];
    return rows.map((row) => this.toDetection(row));
  }

  setOverride(tenantId: string, ruleId: string, config: TenantRuleOverride | null, updatedAtMs: number): void {
    if (config === null) {
      this.db.prepare("DELETE FROM anomaly_rule_overrides WHERE tenant_id = ? AND rule_id = ?").run(tenantId, ruleId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO anomaly_rule_overrides (tenant_id, rule_id, config, updated_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, rule_id) DO UPDATE SET config = excluded.config, updated_at_ms = excluded.updated_at_ms`
      )
      .run(tenantId, ruleId, JSON.stringify(config), updatedAtMs);
  }

  getOverride(tenantId: string, ruleId: string): TenantRuleOverride | undefined {
    const row = this.db
      .prepare("SELECT config FROM anomaly_rule_overrides WHERE tenant_id = ? AND rule_id = ?")
      .get(tenantId, ruleId) as { config: string } | undefined;
    return row ? parseJson<TenantRuleOverride | undefined>(row.config, undefined) : undefined;
  }

  listOverrides(tenantId: string): Record<string, TenantRuleOverride> {
    const rows = this.db
      .prepare("SELECT rule_id, config FROM anomaly_rule_overrides WHERE tenant_id = ? ORDER BY rule_id ASC")
      .all(tenantId) as Array<{ rule_id: string; config: string }>;
    const overrides: Record<string, TenantRuleOverride> = {};
    for (const row of rows) {
      const config = parseJson<TenantRuleOverride | undefined>(row.config, undefined);
      if (config !== undefined) overrides[row.rule_id] = config;
    }
    return overrides;
  }

  /** Every tenant that has ever configured a rule, so overrides are evaluated. */
  tenantsWithOverrides(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT tenant_id FROM anomaly_rule_overrides ORDER BY tenant_id ASC").all() as Array<{ tenant_id: string }>;
    return rows.map((row) => row.tenant_id);
  }

  recordFeedback(feedback: FeedbackRecord): void {
    this.db
      .prepare(
        `INSERT INTO anomaly_feedback (id, detection_id, tenant_id, label, note, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(feedback.id, feedback.detectionId, feedback.tenantId, feedback.label, feedback.note, feedback.createdAtMs);
  }

  listFeedback(detectionId: string): FeedbackRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM anomaly_feedback WHERE detection_id = ? ORDER BY created_at_ms ASC, id ASC")
      .all(detectionId) as Record<string, unknown>[];
    return rows.map((row) => this.toFeedback(row));
  }

  hasFeedback(detectionId: string, label: FeedbackLabel): boolean {
    const row = this.db
      .prepare("SELECT 1 AS one FROM anomaly_feedback WHERE detection_id = ? AND label = ? LIMIT 1")
      .get(detectionId, label) as { one: number } | undefined;
    return row !== undefined;
  }

  feedbackSummary(tenantId: string, ruleId: string, atMs: number): FeedbackSummary {
    const detections = this.db
      .prepare("SELECT mode, COUNT(*) AS count FROM anomaly_detections WHERE tenant_id = ? AND rule_id = ? GROUP BY mode")
      .all(tenantId, ruleId) as Array<{ mode: string; count: number }>;
    const shadow = detections.find((row) => row.mode === "shadow")?.count ?? 0;
    const enforce = detections.find((row) => row.mode === "enforce")?.count ?? 0;
    const labels = this.db
      .prepare(
        `SELECT f.label AS label, COUNT(*) AS count
         FROM anomaly_feedback f JOIN anomaly_detections d ON d.id = f.detection_id
         WHERE d.tenant_id = ? AND d.rule_id = ? GROUP BY f.label`
      )
      .all(tenantId, ruleId) as Array<{ label: string; count: number }>;
    const truePositives = labels.find((row) => row.label === "true_positive")?.count ?? 0;
    const falsePositives = labels.find((row) => row.label === "false_positive")?.count ?? 0;
    const reviewed = truePositives + falsePositives;
    const suppressed = this.db
      .prepare("SELECT COUNT(*) AS count FROM anomaly_suppressions WHERE tenant_id = ? AND rule_id = ? AND expires_at_ms > ?")
      .get(tenantId, ruleId, atMs) as { count: number };
    return {
      rule_id: ruleId,
      tenant_id: tenantId,
      detections: shadow + enforce,
      shadow_detections: shadow,
      enforce_detections: enforce,
      reviewed,
      true_positives: truePositives,
      false_positives: falsePositives,
      false_positive_rate: reviewed === 0 ? 0 : falsePositives / reviewed,
      suppressed_subjects: suppressed.count,
    };
  }

  /** Counts as many labels as one detection can carry; a second review of the
   *  same label is the operator repeating themselves, not new evidence. */
  suppress(suppression: SuppressionRecord): void {
    this.db
      .prepare(
        `INSERT INTO anomaly_suppressions (tenant_id, rule_id, subject_key, expires_at_ms, reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, rule_id, subject_key)
         DO UPDATE SET expires_at_ms = MAX(anomaly_suppressions.expires_at_ms, excluded.expires_at_ms), reason = excluded.reason`
      )
      .run(suppression.tenantId, suppression.ruleId, suppression.subjectKey, suppression.expiresAtMs, suppression.reason);
  }

  isSuppressed(tenantId: string, ruleId: string, subjectKey: string, atMs: number): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS one FROM anomaly_suppressions WHERE tenant_id = ? AND rule_id = ? AND subject_key = ? AND expires_at_ms > ? LIMIT 1"
      )
      .get(tenantId, ruleId, subjectKey, atMs) as { one: number } | undefined;
    return row !== undefined;
  }

  listSuppressions(tenantId: string, atMs: number): SuppressionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM anomaly_suppressions WHERE tenant_id = ? AND expires_at_ms > ? ORDER BY rule_id ASC, subject_key ASC"
      )
      .all(tenantId, atMs) as Array<{ tenant_id: string; rule_id: string; subject_key: string; expires_at_ms: number; reason: string }>;
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      ruleId: row.rule_id,
      subjectKey: row.subject_key,
      expiresAtMs: Number(row.expires_at_ms),
      reason: row.reason,
    }));
  }

  clearSuppressions(tenantId: string, ruleId: string): number {
    return this.db.prepare("DELETE FROM anomaly_suppressions WHERE tenant_id = ? AND rule_id = ?").run(tenantId, ruleId).changes;
  }

  recordAlert(alert: AlertRecord): void {
    this.db
      .prepare(
        `INSERT INTO anomaly_alerts
         (id, detection_id, incident_key, tenant_id, rule_id, type, severity, mode, routed, reason, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        alert.id,
        alert.detectionId,
        alert.incidentKey,
        alert.tenantId,
        alert.ruleId,
        alert.type,
        alert.severity,
        alert.mode,
        alert.routed ? 1 : 0,
        alert.reason,
        alert.atMs
      );
  }

  listAlerts(options: { tenantId: string; limit?: number; routedOnly?: boolean }): AlertRecord[] {
    const clauses = ["tenant_id = @tenantId"];
    const params: Record<string, unknown> = { tenantId: options.tenantId, limit: options.limit ?? 50 };
    if (options.routedOnly) clauses.push("routed = 1");
    const rows = this.db
      .prepare(`SELECT * FROM anomaly_alerts WHERE ${clauses.join(" AND ")} ORDER BY at_ms DESC, id ASC LIMIT @limit`)
      .all(params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      detectionId: String(row.detection_id),
      incidentKey: String(row.incident_key),
      tenantId: String(row.tenant_id),
      ruleId: String(row.rule_id),
      type: String(row.type) as "raised" | "resolved",
      severity: String(row.severity) as Severity,
      mode: String(row.mode) as RuleMode,
      routed: Number(row.routed) === 1,
      reason: (row.reason as string | null) ?? null,
      atMs: Number(row.at_ms),
    }));
  }

  /** The deduper's table, so a boot does not re-page incidents it already raised. */
  loadIncidentState(): string | undefined {
    const row = this.db.prepare("SELECT value FROM indexer_state WHERE key = ?").get(INCIDENT_STATE_KEY) as { value: string } | undefined;
    return row?.value;
  }

  saveIncidentState(serialized: string): void {
    this.db
      .prepare("INSERT INTO indexer_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(INCIDENT_STATE_KEY, serialized);
  }

  private toDetection(row: Record<string, unknown>): Detection {
    return {
      id: String(row.id),
      ruleId: String(row.rule_id),
      ruleVersion: Number(row.rule_version),
      tenantId: String(row.tenant_id),
      severity: String(row.severity) as Severity,
      mode: String(row.mode) as RuleMode,
      subjectKey: String(row.subject_key),
      citation: parseJson<WindowCitation>(String(row.citation), {
        fromLedger: 0,
        toLedger: 0,
        firstEventId: "",
        lastEventId: "",
        startMs: 0,
        endMs: 0,
      }),
      fingerprint: String(row.fingerprint),
      evidence: parseJson<Evidence>(String(row.evidence), { metrics: {}, actors: {}, citedEventIds: [] }),
      params: parseJson<Record<string, number>>(String(row.params), {}),
      createdAtMs: Number(row.created_at_ms),
    };
  }

  private toFeedback(row: Record<string, unknown>): FeedbackRecord {
    return {
      id: String(row.id),
      detectionId: String(row.detection_id),
      tenantId: String(row.tenant_id),
      label: String(row.label) as FeedbackLabel,
      note: (row.note as string | null) ?? null,
      createdAtMs: Number(row.created_at_ms),
    };
  }
}
