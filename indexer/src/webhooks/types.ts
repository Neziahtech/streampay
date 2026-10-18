export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  previous_secret?: string | null;
  events: string[];
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface WebhookEventEnvelope {
  event_id: string;
  event_type: string;
  stream_id: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface WebhookAttemptRecord {
  attempt: number;
  timestamp: number;
  status_code?: number;
  error?: string;
  duration_ms: number;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  stream_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt: number;
  status: "pending" | "delivered" | "failed" | "dead_letter";
  status_code?: number;
  error?: string;
  next_retry_at?: number;
  history: WebhookAttemptRecord[];
  created_at: string;
  completed_at?: string;
}

export interface WebhookDeadLetterItem {
  id: string;
  delivery_id: string;
  endpoint_id: string;
  event_id: string;
  stream_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts_count: number;
  last_error: string;
  last_status_code?: number;
  created_at: string;
  replayed_at?: string;
}
