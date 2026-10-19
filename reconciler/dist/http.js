//! Simple HTTP agent wrapper for making requests with proper error handling.
import { URL } from "node:url";
export class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "HttpError";
    }
}
/**
 * Creates an HTTP agent that returns typed responses.
 * Wraps the node:http client for better DX.
 */
export function createHttpAgent() {
    const fetch = async (url, options) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s timeout
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    "User-Agent": "streampay-reconciler/1.0.0",
                    ...(options.headers || {}),
                },
            });
            clearTimeout(timeoutId);
            // Try to parse JSON body, fallback to text
            let data;
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
                try {
                    data = await response.json();
                }
                catch {
                    data = await response.text();
                }
            }
            else {
                data = await response.text();
            }
            return {
                status: response.status,
                data,
                headers: Object.fromEntries(response.headers.entries()),
            };
        }
        catch (err) {
            clearTimeout(timeoutId);
            if (err instanceof Error && err.name === "AbortError") {
                throw new HttpError(408, "Request timeout");
            }
            if (err instanceof HttpError)
                throw err;
            throw new HttpError(0, `Network error: ${err.message}`);
        }
    };
    return {
        async get(url, headers = {}) {
            return fetch(url, { method: "GET", headers });
        },
        async post(url, body, headers = {}) {
            const stringBody = typeof body === "string" ? body : JSON.stringify(body);
            return fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...headers,
                },
                body: stringBody,
            });
        },
    };
}
// Re-export the fetch function for consumers who need more control
export { createHttpAgent as http };
