import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type {
  Notifier,
  OutgoingNotification,
  DeliveryResult,
  NotificationChannelType,
} from "./types.ts";

export type FetchFunction = typeof globalThis.fetch;

const RESERVED_HEADER_NAMES = new Set([
  "content-type",
  "user-agent",
  "idempotency-key",
  "x-streampay-timestamp",
  "x-streampay-signature",
  "host",
  "content-length",
]);

function isPrivateOrReservedIpv4Octets(parts: number[]): boolean {
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6Words(rawHost: string): number[] | null {
  const zoneStripped = rawHost.split("%")[0].toLowerCase();
  let normalized = zoneStripped;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4Part = normalized.slice(lastColon + 1);
    const octets = ipv4Part.split(".").map((x) => Number(x));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
  const right =
    doubleColonParts.length === 2 && doubleColonParts[1]
      ? doubleColonParts[1].split(":")
      : [];

  if (doubleColonParts.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;

  const missing = 8 - (left.length + right.length);
  const words = [
    ...left,
    ...(doubleColonParts.length === 2 ? Array(missing).fill("0") : []),
    ...right,
  ];
  if (words.length !== 8) return null;

  const parsed: number[] = [];
  for (const w of words) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
    parsed.push(parseInt(w, 16));
  }
  return parsed;
}

function isDisallowedWebhookHost(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (!clean) return true;

  if (
    clean === "localhost" ||
    clean.endsWith(".localhost") ||
    clean.endsWith(".internal") ||
    clean === "metadata.google.internal"
  ) {
    return true;
  }

  if (clean.includes("%")) return true;

  const ipVersion = isIP(clean);
  if (ipVersion === 4) {
    const octets = clean.split(".").map((p) => Number(p));
    return isPrivateOrReservedIpv4Octets(octets);
  }

  if (ipVersion === 6 || clean.includes(":")) {
    const words = expandIpv6Words(clean);
    if (!words) return true;

    const isUnspecified = words.every((w) => w === 0);
    const isLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
    if (isUnspecified || isLoopback) return true;

    const w0 = words[0];
    // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8
    if ((w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xff00) === 0xff00) {
      return true;
    }
    // Documentation 2001:db8::/32
    if (w0 === 0x2001 && words[1] === 0x0db8) return true;

    // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96)
    const isMapped =
      words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0);
    // NAT64 well-known prefix 64:ff9b::/96 or local-use 64:ff9b:1::/48
    const isNat64 =
      w0 === 0x0064 &&
      words[1] === 0xff9b &&
      ((words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) ||
        words[2] === 1);

    if (isMapped || isNat64) {
      const octets = [
        (words[6] >> 8) & 0xff,
        words[6] & 0xff,
        (words[7] >> 8) & 0xff,
        words[7] & 0xff,
      ];
      return isPrivateOrReservedIpv4Octets(octets);
    }

    // 6to4 2002::/16 embeds IPv4 in words[1..2]
    if (w0 === 0x2002) {
      const octets = [
        (words[1] >> 8) & 0xff,
        words[1] & 0xff,
        (words[2] >> 8) & 0xff,
        words[2] & 0xff,
      ];
      if (isPrivateOrReservedIpv4Octets(octets)) return true;
    }

    // Teredo 2001:0000::/32
    if (w0 === 0x2001 && words[1] === 0x0000) return true;
  }

  return false;
}

export function validateNotificationWebhookUrl(rawUrl: string): {
  valid: boolean;
  reason?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "Malformed webhook URL." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, reason: "Webhook URL must use http or https protocol." };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: "Webhook URL must not embed credentials." };
  }

  if (isDisallowedWebhookHost(parsed.hostname)) {
    return {
      valid: false,
      reason: "Webhook URL points to a disallowed internal, loopback, or private host.",
    };
  }

  return { valid: true };
}

function sanitizeCustomHeaders(
  customHeaders?: Record<string, string>
): Record<string, string> {
  if (!customHeaders) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(customHeaders)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || RESERVED_HEADER_NAMES.has(trimmedKey.toLowerCase())) {
      continue;
    }
    if (/[\r\n]/.test(trimmedKey) || /[\r\n]/.test(String(value))) {
      continue;
    }
    sanitized[trimmedKey] = String(value);
  }
  return sanitized;
}

/**
 * Webhook delivery adapter with at-least-once guarantee, idempotency keys,
 * and HMAC-SHA256 request signatures.
 */
export class WebhookNotifier implements Notifier {
  readonly channel: NotificationChannelType = "webhook";
  private readonly customFetch: FetchFunction;

  constructor(customFetch: FetchFunction = globalThis.fetch) {
    this.customFetch = customFetch;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    const config = notification.config.webhook;
    if (!config || !config.url) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Missing webhook URL configuration.",
        retryable: false,
        fatal: true,
      };
    }

    const urlValidation = validateNotificationWebhookUrl(config.url);
    if (!urlValidation.valid) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: urlValidation.reason || "Disallowed webhook target URL.",
        retryable: false,
        fatal: true,
      };
    }

    const payload = JSON.stringify({
      id: notification.id,
      idempotencyKey: notification.idempotencyKey,
      event: notification.event.type,
      timestamp: notification.event.timestamp,
      address: notification.address,
      data: notification.event.payload,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = config.secret
      ? createHmac("sha256", config.secret)
          .update(`${timestamp}.${payload}`)
          .digest("hex")
      : "";

    const headers: Record<string, string> = {
      ...sanitizeCustomHeaders(config.customHeaders),
      "Content-Type": "application/json",
      "User-Agent": "StreamPay-Notifier/1.0",
      "Idempotency-Key": notification.idempotencyKey,
      "X-StreamPay-Timestamp": String(timestamp),
      ...(signature ? { "X-StreamPay-Signature": `t=${timestamp},v1=${signature}` } : {}),
    };

    try {
      const res = await this.customFetch(config.url, {
        method: "POST",
        headers,
        body: payload,
        redirect: "error",
      });

      const now = Math.floor(Date.now() / 1000);
      if (res.ok) {
        return {
          success: true,
          deliveredAt: now,
          statusMessage: `Delivered with HTTP ${res.status}`,
          statusCode: res.status,
          retryable: false,
        };
      }

      // 4xx client errors (except 429) mean the endpoint rejected the payload format or auth: fatal, do not retry
      const isClientError = res.status >= 400 && res.status < 500 && res.status !== 429;
      return {
        success: false,
        deliveredAt: now,
        statusMessage: `Webhook target returned HTTP ${res.status}`,
        statusCode: res.status,
        retryable: !isClientError,
        fatal: isClientError,
      };
    } catch (err) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: `Network error delivering webhook: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      };
    }
  }
}

export interface EmailProvider {
  send(to: string, subject: string, text: string): Promise<{ ok: boolean; status?: number; error?: string; isBounce?: boolean }>;
}

/**
 * Pluggable email delivery adapter supporting SMTP or transactional HTTP APIs (Resend/SendGrid).
 * Includes bounce detection to pause failed addresses.
 */
export class EmailNotifier implements Notifier {
  readonly channel: NotificationChannelType = "email";
  private readonly provider?: EmailProvider;

  constructor(provider?: EmailProvider) {
    this.provider = provider;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    const config = notification.config.email;
    if (!config || !config.email) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Missing destination email address.",
        retryable: false,
        fatal: true,
      };
    }

    const { subject, body } = this.formatContent(notification);

    if (this.provider) {
      const res = await this.provider.send(config.email, subject, body);
      const now = Math.floor(Date.now() / 1000);
      if (res.ok) {
        return {
          success: true,
          deliveredAt: now,
          statusMessage: `Email accepted by delivery provider.`,
          retryable: false,
        };
      }
      return {
        success: false,
        deliveredAt: now,
        statusMessage: res.error || "Provider rejected email transmission.",
        statusCode: res.status,
        retryable: !res.isBounce,
        isBounce: res.isBounce,
      };
    }

    // Default mock behavior when no SMTP provider is injected
    return {
      success: true,
      deliveredAt: Math.floor(Date.now() / 1000),
      statusMessage: `Delivered to simulated inbox for ${config.email}`,
      retryable: false,
    };
  }

  private formatContent(notification: OutgoingNotification): { subject: string; body: string } {
    const event = notification.event;
    const typeLabel = event.type.toUpperCase();
    const streamId = event.payload.streamId;

    return {
      subject: `[StreamPay] ${typeLabel} Alert for Stream #${streamId}`,
      body: [
        `StreamPay Event: ${event.type}`,
        `Stream ID: #${streamId}`,
        `Address: ${notification.address}`,
        event.payload.amount ? `Amount: ${event.payload.amount}` : "",
        event.payload.reason ? `Reason: ${event.payload.reason}` : "",
        `Time: ${new Date(event.timestamp * 1000).toUTCString()}`,
        `Idempotency Key: ${notification.idempotencyKey}`,
      ].filter(Boolean).join("\n"),
    };
  }
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<{ ok: boolean; statusCode?: number; retryAfter?: number; error?: string }>;
}

/**
 * Telegram Bot API notification adapter with Markdown formatting and rate-limit handling.
 */
export class TelegramNotifier implements Notifier {
  readonly channel: NotificationChannelType = "telegram";
  private readonly client?: TelegramClient;

  constructor(client?: TelegramClient) {
    this.client = client;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    const config = notification.config.telegram;
    if (!config || !config.chatId) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Missing Telegram chatId configuration.",
        retryable: false,
        fatal: true,
      };
    }

    const message = this.formatTelegramMessage(notification);

    if (this.client) {
      const res = await this.client.sendMessage(config.chatId, message);
      const now = Math.floor(Date.now() / 1000);
      if (res.ok) {
        return {
          success: true,
          deliveredAt: now,
          statusMessage: "Message sent via Telegram Bot API.",
          retryable: false,
        };
      }

      // 403 Forbidden indicates user blocked the bot: fatal
      const isFatal = res.statusCode === 403;
      return {
        success: false,
        deliveredAt: now,
        statusMessage: res.error || "Telegram Bot API error",
        statusCode: res.statusCode,
        retryable: !isFatal,
        fatal: isFatal,
      };
    }

    return {
      success: true,
      deliveredAt: Math.floor(Date.now() / 1000),
      statusMessage: `Delivered to simulated Telegram chat ${config.chatId}`,
      retryable: false,
    };
  }

  private formatTelegramMessage(notification: OutgoingNotification): string {
    const { event } = notification;
    return [
      `🔔 *StreamPay Alert: ${event.type.toUpperCase()}*`,
      `*Stream:* \`#${event.payload.streamId}\``,
      `*Address:* \`${notification.address}\``,
      event.payload.amount ? `*Amount:* \`${event.payload.amount}\`` : "",
      event.payload.reason ? `*Details:* ${event.payload.reason}` : "",
      `*Time:* ${new Date(event.timestamp * 1000).toISOString()}`,
    ].filter(Boolean).join("\n");
  }
}

/**
 * In-memory test sink for recording dispatched events in integration tests.
 */
export class MockSinkNotifier implements Notifier {
  readonly channel: NotificationChannelType;
  readonly delivered: OutgoingNotification[] = [];
  failAttempts = 0;
  isBounce = false;

  constructor(channel: NotificationChannelType = "webhook") {
    this.channel = channel;
  }

  async deliver(notification: OutgoingNotification): Promise<DeliveryResult> {
    if (this.failAttempts > 0) {
      this.failAttempts -= 1;
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "Simulated mock transmission failure",
        statusCode: 500,
        retryable: true,
      };
    }

    if (this.isBounce) {
      return {
        success: false,
        deliveredAt: Math.floor(Date.now() / 1000),
        statusMessage: "550 5.1.1 User unknown",
        statusCode: 550,
        retryable: false,
        isBounce: true,
      };
    }

    this.delivered.push(notification);
    return {
      success: true,
      deliveredAt: Math.floor(Date.now() / 1000),
      statusMessage: "Delivered to mock sink",
      retryable: false,
    };
  }
}
