/**
 * StreamPay Telemetry Privacy Line Enforcement for infra/indexer.
 *
 * Implements strict sanitization rules to guarantee that:
 * 1. Stellar wallet addresses never enter traces in full (8-character prefix only).
 * 2. Secrets, seeds (S...), private keys, and auth tokens are strictly redacted.
 * 3. Notification destinations (webhooks, email, telegram) have sensitive paths and IDs masked.
 * 4. Error messages are sanitized before attaching to spans.
 *
 * See docs/PRIVACY.md for the full specification.
 */
const STELLAR_ADDRESS_REGEX = /^[GCB][A-Z2-7]{55}$/;
const STELLAR_SECRET_REGEX = /S[A-Za-z0-9]{30,60}/g;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
export function sanitizeAddress(address) {
    if (!address)
        return "unknown";
    const trimmed = address.trim();
    if (trimmed.length <= 8)
        return trimmed;
    return `${trimmed.slice(0, 8)}...`;
}
export function sanitizeWebhookUrl(rawUrl) {
    if (!rawUrl)
        return "unknown";
    try {
        const parsed = new URL(rawUrl);
        return `${parsed.protocol}//${parsed.host}/***`;
    }
    catch {
        return "invalid_url";
    }
}
export function sanitizeEmail(email) {
    if (!email || !email.includes("@"))
        return "unknown";
    const parts = email.split("@");
    return `***@${parts[1]}`;
}
export function sanitizeTelegramChatId(chatId) {
    if (!chatId)
        return "unknown";
    const str = String(chatId).trim();
    if (str.length <= 4)
        return "chat_***";
    return `chat_***${str.slice(-4)}`;
}
export function sanitizeError(err) {
    const raw = err instanceof Error ? (err.stack || err.message) : String(err);
    return raw
        .replace(STELLAR_SECRET_REGEX, "[REDACTED_SECRET_KEY]")
        .replace(BEARER_TOKEN_REGEX, "Bearer [REDACTED_TOKEN]");
}
export function sanitizeAttributes(attributes) {
    const sanitized = {};
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null)
            continue;
        if (key.toLowerCase().includes("address") ||
            key.toLowerCase().includes("sender") ||
            key.toLowerCase().includes("recipient") ||
            key.toLowerCase().includes("wallet")) {
            if (typeof value === "string") {
                sanitized[key] = sanitizeAddress(value);
            }
            else {
                sanitized[key] = String(value);
            }
            continue;
        }
        if (key.toLowerCase().includes("webhook") || key.toLowerCase().includes("url")) {
            if (typeof value === "string") {
                sanitized[key] = sanitizeWebhookUrl(value);
            }
            else {
                sanitized[key] = String(value);
            }
            continue;
        }
        if (key.toLowerCase().includes("email")) {
            sanitized[key] = sanitizeEmail(String(value));
            continue;
        }
        if (key.toLowerCase().includes("telegram") || key.toLowerCase().includes("chat_id")) {
            sanitized[key] = sanitizeTelegramChatId(value);
            continue;
        }
        if (typeof value === "string" && STELLAR_ADDRESS_REGEX.test(value)) {
            sanitized[key] = sanitizeAddress(value);
            continue;
        }
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            sanitized[key] = value;
        }
        else {
            sanitized[key] = JSON.stringify(value);
        }
    }
    return sanitized;
}
