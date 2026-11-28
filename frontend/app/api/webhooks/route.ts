import { NextResponse } from "next/server";

const INDEXER_URL = process.env.INDEXER_URL || "http://localhost:8787";

/**
 * The dashboard is one subscriber talking to a shared indexer. When the
 * deployment provisions tenant credentials, the BFF presents them; an indexer
 * configured for a single tenant needs no key and behaves as it always did.
 */
const INDEXER_TENANT_KEY = process.env.INDEXER_WEBHOOK_TENANT_KEY || "";

function indexerHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return INDEXER_TENANT_KEY === "" ? headers : { ...headers, "x-streampay-webhook-key": INDEXER_TENANT_KEY };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "endpoints";

  let path = "/api/webhooks/endpoints";
  if (type === "deliveries") {
    path = "/api/webhooks/deliveries";
  } else if (type === "dlq") {
    path = "/api/webhooks/dlq";
  }

  try {
    const res = await fetch(`${INDEXER_URL}${path}`, {
      headers: indexerHeaders({ "Content-Type": "application/json" }),
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Indexer responded with status ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: `Indexer unavailable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "create") {
      const { url, events } = body;
      const res = await fetch(`${INDEXER_URL}/api/webhooks/endpoints`, {
        method: "POST",
        headers: indexerHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ url, events }),
      });
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    if (action === "rotate") {
      const { id } = body;
      const res = await fetch(`${INDEXER_URL}/api/webhooks/endpoints/${id}/rotate-secret`, {
        method: "POST",
        headers: indexerHeaders({ "Content-Type": "application/json" }),
      });
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    if (action === "delete") {
      const { id } = body;
      const res = await fetch(`${INDEXER_URL}/api/webhooks/endpoints/${id}`, {
        method: "DELETE",
        headers: indexerHeaders(),
      });
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    if (action === "test") {
      const { id } = body;
      const res = await fetch(`${INDEXER_URL}/api/webhooks/endpoints/${id}/test`, {
        method: "POST",
        headers: indexerHeaders(),
      });
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    if (action === "replay_dlq") {
      const { id } = body;
      const res = await fetch(`${INDEXER_URL}/api/webhooks/dlq/${id}/retry`, {
        method: "POST",
        headers: indexerHeaders(),
      });
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: `Webhook operation failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
