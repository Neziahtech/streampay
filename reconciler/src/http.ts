//! HTTP client wrapper used by both readers and the alerting service.

export interface HttpResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpAgent {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `requestFn` is injectable so tests and callers can substitute a client
 * without patching the global.
 */
export function createHttpAgent(requestFn: typeof fetch = globalThis.fetch): HttpAgent {
  const request = async (url: string, options: RequestInit): Promise<HttpResponse> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await requestFn(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "streampay-reconciler/1.0.0",
          ...(options.headers ?? {}),
        },
      });

      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? await response.json().catch(() => response.text())
        : await response.text();

      return {
        status: response.status,
        data,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new HttpError(408, "Request timeout");
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(0, `Network error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return {
    get: (url, headers = {}) => request(url, { method: "GET", headers }),
    post: (url, body, headers = {}) =>
      request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

// Re-export the fetch factory for consumers who need more control.
export { createHttpAgent as http };
