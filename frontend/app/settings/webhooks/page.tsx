"use client";

import Link from "next/link";
import SettingsNav from "@/components/SettingsNav";
import { useEffect, useState, useCallback } from "react";
import { useToast } from "@/components/toast";

interface WebhookEndpoint {
  id: string;
  url: string;
  /** Only ever present on the response that mints or rotates it. */
  secret?: string;
  /** What every other read carries instead of the secret. */
  secret_fingerprint?: string;
  previous_secret?: string | null;
  tenant_id?: string;
  events: string[];
  status: "active" | "disabled";
  created_at: string;
  updated_at?: string;
}

interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  stream_id: string;
  event_type: string;
  attempt: number;
  status: "pending" | "delivered" | "failed" | "dead_letter";
  status_code?: number;
  error?: string;
  next_retry_at: number;
  created_at: string;
  completed_at?: string;
}

interface WebhookDLQItem {
  id: string;
  delivery_id: string;
  endpoint_id: string;
  event_id: string;
  stream_id: string;
  event_type: string;
  attempts_count: number;
  last_error: string;
  last_status_code?: number;
  created_at: string;
  replayed_at?: string;
}

const ALL_EVENT_TYPES = [
  "stream_created",
  "withdrawn",
  "stream_cancelled",
  "stream_topped_up",
  "stream_paused",
  "stream_resumed",
];

export default function WebhooksSettingsPage() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<"endpoints" | "deliveries" | "dlq">("endpoints");

  // Data states
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [dlqItems, setDlqItems] = useState<WebhookDLQItem[]>([]);

  // Form states
  const [newUrl, setNewUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([...ALL_EVENT_TYPES]);
  const [submitting, setSubmitting] = useState(false);

  // New secret modal / banner
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      if (activeTab === "endpoints") {
        const res = await fetch("/api/webhooks?type=endpoints");
        if (res.ok) setEndpoints(await res.json());
      } else if (activeTab === "deliveries") {
        const res = await fetch("/api/webhooks?type=deliveries");
        if (res.ok) setDeliveries(await res.json());
      } else if (activeTab === "dlq") {
        const res = await fetch("/api/webhooks?type=dlq");
        if (res.ok) setDlqItems(await res.json());
      }
    } catch (e: unknown) {
      toast.error(`Failed to load webhook data: ${String(e)}`);
    }
  }, [activeTab, toast]);

  useEffect(() => {
    // Loads the tab's rows whenever the tab changes. Every setState inside
    // loadData runs after an await, so this is not a cascading render — the
    // rule only sees that the called function touches state at all.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData();
    void (async () => {
      await loadData();
    })();
  }, [loadData]);

  async function handleRegisterEndpoint(e: React.FormEvent) {
    e.preventDefault();
    if (!newUrl.trim()) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          url: newUrl.trim(),
          events: selectedEvents,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to register webhook endpoint");
        return;
      }

      toast.success("Webhook endpoint registered successfully!");
      setRevealedSecret({ id: data.id, secret: data.secret });
      setNewUrl("");
      void loadData();
    } catch (err: unknown) {
      toast.error(`Registration error: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRotateSecret(id: string) {
    if (!confirm("Rotate webhook signing secret? StreamPay will support dual-signature verification for a transition window.")) {
      return;
    }

    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate", id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Secret rotation failed");
        return;
      }

      toast.success("Signing secret rotated successfully!");
      setRevealedSecret({ id, secret: data.secret });
      void loadData();
    } catch (err: unknown) {
      toast.error(`Rotation error: ${String(err)}`);
    }
  }

  async function handleDeleteEndpoint(id: string) {
    if (!confirm("Are you sure you want to delete this webhook endpoint?")) return;

    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      if (!res.ok) {
        toast.error("Failed to delete endpoint");
        return;
      }
      toast.success("Webhook endpoint deleted");
      void loadData();
    } catch (err: unknown) {
      toast.error(`Delete error: ${String(err)}`);
    }
  }

  async function handleTestFire(id: string) {
    try {
      toast.info("Sending test ping webhook event…");
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", id }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Test ping delivered! HTTP ${data.statusCode}`);
      } else {
        toast.error(`Test ping failed: ${data.error || `HTTP ${data.statusCode}`}`);
      }
      void loadData();
    } catch (err: unknown) {
      toast.error(`Test fire error: ${String(err)}`);
    }
  }

  async function handleReplayDLQ(id: string) {
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "replay_dlq", id }),
      });
      if (!res.ok) {
        toast.error("Failed to replay DLQ item");
        return;
      }
      toast.success("Event re-enqueued for fresh delivery!");
      void loadData();
    } catch (err: unknown) {
      toast.error(`Replay error: ${String(err)}`);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--accent-subtle)] text-[var(--accent-primary)] p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-[var(--foreground-muted)]">
          <Link href="/" className="hover:text-[var(--foreground-default)] transition">← Dashboard</Link>
          <span>/</span>
          <span className="text-[var(--foreground-default)]">Webhook Settings</span>
        </div>
        <SettingsNav />

        {/* Title */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-extrabold text-[var(--foreground-default)] tracking-tight">Outbound Webhooks</h1>
            <p className="text-sm text-[var(--foreground-muted)] mt-1">
              Deterministic events with HMAC-SHA256 signatures, replay protection, 5-attempt retry backoff, and DLQ observability.
            </p>
            <a
              href="https://github.com/Neziahtech/streampay/blob/main/docs/WEBHOOKS.md"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[var(--accent-primary)] hover:text-[var(--accent-primary-hover)] underline mt-2 inline-block"
            >
              Read the webhook signature and verification guide
            </a>
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            className="px-4 py-2 bg-[var(--surface-raised)] border border-[var(--border-default)] hover:border-[var(--border-strong)] rounded-xl text-xs font-medium text-[var(--foreground-default)] transition"
          >
            ↻ Refresh
          </button>
        </div>

        {/* Secret Display Banner */}
        {revealedSecret && (
          <div className="bg-[var(--status-success-subtle)] border border-[var(--status-success-border)] rounded-2xl p-5 text-sm space-y-2">
            <div className="flex justify-between items-center">
              <span className="font-bold text-[var(--status-success)] flex items-center gap-2">
                🔑 Webhook Signing Secret Generated
              </span>
              <button
                type="button"
                onClick={() => setRevealedSecret(null)}
                className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] text-xs"
              >
                ✕ Dismiss
              </button>
            </div>
            <p className="text-xs text-[var(--status-success)]">
              Copy this secret now. It will not be shown again in plain text. Use it to verify the <code>Streampay-Signature</code> header.
            </p>
            <div className="flex items-center gap-2 bg-[var(--surface-inset)] p-2.5 rounded-xl border border-[var(--border-default)] font-mono text-xs text-[var(--foreground-default)] overflow-x-auto">
              <span className="flex-1 select-all">{revealedSecret.secret}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(revealedSecret.secret);
                  toast.success("Secret copied to clipboard!");
                }}
                className="px-3 py-1 bg-[var(--status-success-button)] hover:bg-[var(--status-success-button-end)] text-[var(--foreground-on-success)] rounded-lg text-xs font-semibold"
              >
                Copy
              </button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 border-b border-[var(--border-default)] pb-2">
          <button
            type="button"
            onClick={() => setActiveTab("endpoints")}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
              activeTab === "endpoints"
                ? "bg-[var(--accent-subtle)] text-[var(--accent-primary)]"
                : "text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"
            }`}
          >
            Endpoints ({endpoints.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("deliveries")}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
              activeTab === "deliveries"
                ? "bg-[var(--accent-subtle)] text-[var(--accent-primary)]"
                : "text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"
            }`}
          >
            Delivery Logs
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("dlq")}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
              activeTab === "dlq"
                ? "bg-[var(--accent-subtle)] text-[var(--accent-primary)]"
                : "text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"
            }`}
          >
            Dead-Letter Queue (DLQ) {dlqItems.length > 0 && `(${dlqItems.length})`}
          </button>
        </div>

        {/* Tab 1: Endpoints */}
        {activeTab === "endpoints" && (
          <div className="space-y-8">
            {/* New Endpoint Form */}
            <form
              onSubmit={handleRegisterEndpoint}
              className="bg-[var(--surface-raised)] border border-[var(--border-default)] rounded-2xl p-6 space-y-4"
            >
              <h2 className="text-lg font-bold text-[var(--foreground-default)]">Register New Webhook Endpoint</h2>
              <div className="space-y-2">
                <label htmlFor="webhook-url" className="text-xs text-[var(--foreground-muted)] font-medium">
                  Endpoint Destination URL (SSRF Guarded)
                </label>
                <input
                  id="webhook-url"
                  type="url"
                  required
                  placeholder="https://api.yourdomain.com/webhooks/streampay"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  className="w-full px-4 py-2.5 bg-[var(--surface-inset)] border border-[var(--border-control)] rounded-xl text-sm text-[var(--foreground-default)] placeholder:text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
                />
                <span className="text-xs text-[var(--foreground-muted)] block">
                  Private RFC-1918, loopback, and cloud metadata IPs are automatically rejected.
                </span>
              </div>

              <div>
                <label className="text-xs text-[var(--foreground-muted)] font-medium block mb-2">
                  Subscribed Event Types
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {ALL_EVENT_TYPES.map((ev) => (
                    <label
                      key={ev}
                      className="flex items-center gap-2 p-2 bg-[var(--surface-inset)] rounded-xl border border-[var(--border-control)] text-xs text-[var(--foreground-default)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedEvents.includes(ev)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedEvents([...selectedEvents, ev]);
                          } else {
                            setSelectedEvents(selectedEvents.filter((x) => x !== ev));
                          }
                        }}
                      />
                      <code>{ev}</code>
                    </label>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="px-6 py-2.5 bg-[var(--accent-strong)] hover:bg-[var(--accent-strong-hover)] disabled:opacity-50 text-[var(--foreground-on-accent)] rounded-xl text-sm font-semibold transition"
              >
                {submitting ? "Registering…" : "Register Endpoint"}
              </button>
            </form>

            {/* Endpoints List */}
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-[var(--foreground-default)]">Configured Endpoints</h2>
              {endpoints.length === 0 ? (
                <p className="text-sm text-[var(--foreground-muted)]">No webhook endpoints registered yet.</p>
              ) : (
                <div className="space-y-3">
                  {endpoints.map((ep) => (
                    <div
                      key={ep.id}
                      className="bg-[var(--surface-raised)] border border-[var(--border-default)] rounded-2xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
                    >
                      <div className="space-y-1 max-w-xl">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold text-[var(--foreground-default)]">{ep.url}</span>
                          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[var(--status-success-subtle)] text-[var(--status-success)] border border-[var(--status-success-border)]">
                            {ep.status}
                          </span>
                        </div>
                        <div className="text-xs text-[var(--foreground-muted)] font-mono">
                          ID: {ep.id} • Created: {new Date(ep.created_at).toLocaleDateString()}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {ep.events.map((ev) => (
                            <span
                              key={ev}
                              className="px-2 py-0.5 bg-[var(--surface-inset)] text-[var(--foreground-muted)] border border-[var(--border-default)] rounded-md text-xs font-mono"
                            >
                              {ev}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleTestFire(ep.id)}
                          className="px-3 py-1.5 bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] text-[var(--foreground-default)] rounded-xl text-xs font-semibold transition"
                        >
                          ⚡ Test Fire
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRotateSecret(ep.id)}
                          className="px-3 py-1.5 bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] text-[var(--status-warning)] rounded-xl text-xs font-semibold transition"
                        >
                          🔄 Rotate Secret
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteEndpoint(ep.id)}
                          className="px-3 py-1.5 bg-[var(--status-danger-subtle)] hover:border-[var(--status-danger)] text-[var(--status-danger)] border border-[var(--status-danger-border)] rounded-xl text-xs font-semibold transition"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Delivery Logs */}
        {activeTab === "deliveries" && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-[var(--foreground-default)]">Recent Delivery Attempts</h2>
            {deliveries.length === 0 ? (
              <p className="text-sm text-[var(--foreground-muted)]">No delivery logs recorded yet.</p>
            ) : (
              <div className="bg-[var(--surface-raised)] border border-[var(--border-default)] rounded-2xl overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[var(--surface-inset)] border-b border-[var(--border-default)] text-[var(--foreground-muted)] font-medium">
                    <tr>
                      <th className="p-3">Status</th>
                      <th className="p-3">Event</th>
                      <th className="p-3">Stream #</th>
                      <th className="p-3">Attempt</th>
                      <th className="p-3">HTTP Status</th>
                      <th className="p-3">Created At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-default)] font-mono">
                    {deliveries.map((d) => (
                      <tr key={d.id} className="hover:bg-[var(--surface-hover)] transition">
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                              d.status === "delivered"
                                ? "bg-[var(--status-success-subtle)] text-[var(--status-success)] border border-[var(--status-success-border)]"
                                : d.status === "dead_letter"
                                ? "bg-[var(--status-danger-subtle)] text-[var(--status-danger)] border border-[var(--status-danger-border)]"
                                : "bg-[var(--status-warning-subtle)] text-[var(--status-warning)] border border-[var(--status-warning-border)]"
                            }`}
                          >
                            {d.status}
                          </span>
                        </td>
                        <td className="p-3 font-semibold text-[var(--foreground-default)]">{d.event_type}</td>
                        <td className="p-3">#{d.stream_id}</td>
                        <td className="p-3">{d.attempt} / 5</td>
                        <td className="p-3 text-[var(--foreground-default)]">{d.status_code ?? "—"}</td>
                        <td className="p-3 text-[var(--foreground-muted)]">{new Date(d.created_at).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Dead-Letter Queue (DLQ) */}
        {activeTab === "dlq" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-[var(--foreground-default)]">Dead-Letter Queue (DLQ)</h2>
              <p className="text-xs text-[var(--foreground-muted)] mt-0.5">
                Events that failed all 5 delivery attempts across exponential backoff (~1 hr window).
              </p>
            </div>

            {dlqItems.length === 0 ? (
              <div className="bg-[var(--surface-raised)] border border-[var(--border-default)] rounded-2xl p-8 text-center text-sm text-[var(--foreground-muted)]">
                ✓ No dead-letter items. All webhooks delivered successfully.
              </div>
            ) : (
              <div className="space-y-3">
                {dlqItems.map((item) => (
                  <div
                    key={item.id}
                    className="bg-[var(--surface-raised)] border border-[var(--status-danger-border)] rounded-2xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-[var(--status-danger)] text-sm">{item.event_type}</span>
                        <span className="text-xs text-[var(--foreground-muted)] font-mono">Stream #{item.stream_id}</span>
                        <span className="px-2 py-0.5 bg-[var(--status-danger-subtle)] text-[var(--status-danger)] rounded-full text-xs font-mono font-semibold">
                          5 / 5 Exhausted
                        </span>
                      </div>
                      <p className="text-xs text-[var(--foreground-muted)]">
                        Last Error: <span className="text-[var(--status-danger)] font-mono">{item.last_error}</span>
                        {item.last_status_code && ` (HTTP ${item.last_status_code})`}
                      </p>
                      <span className="text-xs text-[var(--foreground-muted)] font-mono block">
                        DLQ Item: {item.id} • Queued: {new Date(item.created_at).toLocaleString()}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleReplayDLQ(item.id)}
                      className="px-4 py-2 bg-[var(--accent-strong)] hover:bg-[var(--accent-strong-hover)] text-[var(--foreground-on-accent)] rounded-xl text-xs font-semibold transition"
                    >
                      Replay / Retry
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
