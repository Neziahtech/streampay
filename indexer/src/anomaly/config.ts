import type { AnomalyStore } from "./store.js";
import type { EffectiveRule, RuleSource } from "./rules.js";
import { RULE_IDS, effectiveRule, parseRuleOverrides } from "./rules.js";
import type { RuleMode, TenantRuleOverride } from "./types.js";

export const RULE_OVERRIDES_ENV = "ANOMALY_RULES_JSON";
export const RULE_MODE_ENV = "ANOMALY_MODE";
export const HYDRATE_LEDGERS_ENV = "ANOMALY_HYDRATE_LEDGERS";
export const SUPPRESSION_TTL_ENV = "ANOMALY_SUPPRESSION_TTL_MS";
/** Cap on how many journal rows one replay may read. */
export const REPLAY_MAX_EVENTS_ENV = "ANOMALY_REPLAY_MAX_EVENTS";
export const DEFAULT_SUPPRESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a resolved rule configuration may be cached before it is re-read. */
export const DEFAULT_CONFIG_CACHE_MS = 30_000;

/**
 * A tenant's view of a tenant that does not exist yet reads as "no override",
 * so the directory — not the request — decides who is configured.
 */
export interface TenantDirectoryLike {
  list(): Array<{ tenantId: string; disabled: boolean }>;
}

export interface TenantRuleSourceOptions {
  store: AnomalyStore;
  directory?: TenantDirectoryLike | null;
  /** Deployment-wide defaults, e.g. from `ANOMALY_RULES_JSON`. */
  base?: Record<string, TenantRuleOverride>;
  /** Mode applied to every rule that neither the base nor the tenant configured. */
  defaultMode?: RuleMode;
  /** Tenant evaluated when the deployment provisions no directory. */
  defaultTenantId?: string;
  cacheMs?: number;
  now?: () => number;
}

interface CacheEntry {
  atMs: number;
  rules: readonly EffectiveRule[];
}

/**
 * Resolves the rule set the engine evaluates, per tenant: catalog defaults,
 * then the deployment's base configuration, then that tenant's own overrides.
 *
 * Overrides are read through the store and cached briefly, because the engine
 * asks for every tenant on every event. The cache is invalidated when the API
 * writes, so a tuning change takes effect immediately in this process.
 */
export class TenantRuleSource implements RuleSource {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly base: Record<string, TenantRuleOverride>;
  private readonly defaultMode: RuleMode;
  private readonly defaultTenantId: string;
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TenantRuleSourceOptions) {
    this.base = options.base ?? {};
    this.defaultMode = options.defaultMode ?? "shadow";
    this.defaultTenantId = options.defaultTenantId ?? "default";
    this.cacheMs = options.cacheMs ?? DEFAULT_CONFIG_CACHE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  tenants(): string[] {
    const tenants = new Set<string>([this.defaultTenantId, ...this.options.store.tenantsWithOverrides()]);
    for (const record of this.options.directory?.list() ?? []) {
      if (!record.disabled) tenants.add(record.tenantId);
    }
    return [...tenants].sort();
  }

  rulesFor(tenantId: string): readonly EffectiveRule[] {
    const cached = this.cache.get(tenantId);
    const atMs = this.now();
    if (cached !== undefined && atMs - cached.atMs < this.cacheMs) return cached.rules;
    const rules = this.resolve(tenantId);
    this.cache.set(tenantId, { atMs, rules });
    return rules;
  }

  /** Drop the cache for one tenant, or all of them. */
  invalidate(tenantId?: string): void {
    if (tenantId === undefined) this.cache.clear();
    else this.cache.delete(tenantId);
  }

  isSuppressed(tenantId: string, ruleId: string, subjectKey: string, atMs: number): boolean {
    return this.options.store.isSuppressed(tenantId, ruleId, subjectKey, atMs);
  }

  private resolve(tenantId: string): readonly EffectiveRule[] {
    const tenantOverrides = this.options.store.listOverrides(tenantId);
    return RULE_IDS.map((ruleId) => {
      const override: TenantRuleOverride = { ...this.base[ruleId], ...tenantOverrides[ruleId] };
      // `params` are per-rule objects, so a shallow merge would let the tenant
      // override drop the deployment's other thresholds for that rule.
      const baseParams = this.base[ruleId]?.params ?? {};
      const tenantParams = tenantOverrides[ruleId]?.params ?? {};
      override.params = { ...baseParams, ...tenantParams };
      return effectiveRule(ruleId, override, { mode: this.defaultMode });
    });
  }
}

/**
 * Read the deployment's rule configuration from the environment. A malformed
 * file fails at boot rather than silently running the catalog defaults, which
 * is the difference between "the rule is tuned" and "the rule is not".
 */
export function ruleOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, TenantRuleOverride> {
  const raw = env[RULE_OVERRIDES_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${RULE_OVERRIDES_ENV} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRuleOverrides(parsed);
}

export function defaultModeFromEnv(env: NodeJS.ProcessEnv = process.env): RuleMode {
  const raw = env[RULE_MODE_ENV];
  if (raw === undefined || raw.trim() === "") return "shadow";
  if (raw !== "shadow" && raw !== "enforce") throw new Error(`${RULE_MODE_ENV} must be 'shadow' or 'enforce'`);
  return raw;
}

export interface PromotionReport {
  rule_id: string;
  tenant_id: string;
  mode: RuleMode;
  version: number;
  review_required: boolean;
  reviewed: number;
  min_reviews: number;
  false_positives: number;
  false_positive_rate: number;
  false_positive_budget: number;
  detections: number;
  shadow_detections: number;
  ready: boolean;
  reasons: string[];
}

/**
 * Is this rule safe to page on? A rule graduates from shadow only once an
 * operator has actually reviewed enough of its detections to measure it, and
 * only while the measured false-positive rate fits the budget. Both halves are
 * required: "no false positives out of three reviews" is not evidence, and a
 * rule with zero detections has proven nothing either.
 */
export function promotionReport(
  store: AnomalyStore,
  rules: RuleSource,
  tenantId: string,
  ruleId: string,
  atMs: number
): PromotionReport {
  const rule = rules.rulesFor(tenantId).find((candidate) => candidate.id === ruleId);
  if (rule === undefined) throw new Error(`unknown rule '${ruleId}'`);
  const summary = store.feedbackSummary(tenantId, ruleId, atMs);
  const reasons: string[] = [];

  if (summary.reviewed < rule.config.minReviews) {
    reasons.push(`needs ${rule.config.minReviews - summary.reviewed} more reviewed detections (min_reviews=${rule.config.minReviews})`);
  }
  if (summary.detections === 0) reasons.push("the rule has never fired, so its thresholds are untested against this traffic");
  if (summary.false_positive_rate > rule.config.falsePositiveBudget) {
    reasons.push(
      `false-positive rate ${(summary.false_positive_rate * 100).toFixed(1)}% is over the ${(rule.config.falsePositiveBudget * 100).toFixed(1)}% budget`
    );
  }

  return {
    rule_id: rule.id,
    tenant_id: tenantId,
    mode: rule.config.mode,
    version: rule.version,
    review_required: rule.config.mode === "shadow",
    reviewed: summary.reviewed,
    min_reviews: rule.config.minReviews,
    false_positives: summary.false_positives,
    false_positive_rate: Number(summary.false_positive_rate.toFixed(6)),
    false_positive_budget: rule.config.falsePositiveBudget,
    detections: summary.detections,
    shadow_detections: summary.shadow_detections,
    ready: reasons.length === 0,
    reasons,
  };
}
