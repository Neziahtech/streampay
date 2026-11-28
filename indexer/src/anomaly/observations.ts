import type { Observation, ObservationRole } from "./types.js";

/**
 * The event fields the rules read, in the two shapes they exist in: a decoded
 * contract event on the live path, and the JSON payload of the `events` journal
 * on the replay path. Bigints are decimal strings in the journal, so both
 * branches below have to agree on the canonical form.
 */
export interface EventInput {
  id: string;
  name: string;
  ledger: number;
  ledgerClosedAt: string;
  streamId: string | null;
  data: Record<string, unknown>;
}

const ROLE_BY_NAME: Record<string, ObservationRole> = {
  stream_created: "create",
  streams_created: "create",
  stream_cancelled: "cancel",
  withdrawn: "withdraw",
};

function decimal(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? String(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

function address(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Streams an event created: one, or the batch's count. */
function createdCount(name: string, data: Record<string, unknown>): number {
  if (name === "stream_created") return 1;
  if (name !== "streams_created") return 0;
  const ids = data["stream_ids"];
  return Array.isArray(ids) ? ids.length : 0;
}

/**
 * Reduce one event to an observation, or drop it when no rule can read it.
 * Returning `null` for an unknown name is what keeps the sliding windows
 * bounded on a contract that publishes far more event types than this detector
 * knows about.
 */
export function toObservation(event: EventInput): Observation | null {
  const role = ROLE_BY_NAME[event.name];
  if (role === undefined) return null;

  const atMs = Date.parse(event.ledgerClosedAt);
  if (!Number.isFinite(atMs)) return null;

  const sender = address(event.data["sender"]);
  const recipient = address(event.data["recipient"]);
  const cancelledBy = address(event.data["cancelled_by"]);

  return {
    eventId: event.id,
    ledger: event.ledger,
    atMs,
    name: event.name,
    role,
    streamId: event.streamId,
    sender,
    recipient,
    // A cancel names its own actor, so churn attribution survives replay even
    // when the stream was created outside the cited range.
    actor: role === "cancel" ? (cancelledBy ?? sender) : (sender ?? recipient),
    amount: decimal(event.data["deposit"]) ?? decimal(event.data["amount"]),
    created: createdCount(event.name, event.data),
  };
}
