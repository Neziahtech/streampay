/**
 * OpenTelemetry Distributed Tracing Core for infra/indexer.
 */
import { sanitizeAttributes, sanitizeError } from "./privacy.js";
export function generateSpanId() {
    const bytes = new Uint8Array(8);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    }
    else {
        for (let i = 0; i < 8; i++)
            bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function generateTraceId() {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    }
    else {
        for (let i = 0; i < 16; i++)
            bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export class W3CTraceContextPropagator {
    static parseTraceParent(headerValue) {
        if (!headerValue)
            return null;
        const match = headerValue.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
        if (!match)
            return null;
        const traceId = match[1].toLowerCase();
        const spanId = match[2].toLowerCase();
        const traceFlags = parseInt(match[3], 16);
        if (/^0+$/.test(traceId) || /^0+$/.test(spanId))
            return null;
        return { traceId, spanId, traceFlags };
    }
    static formatTraceParent(context) {
        const flags = context.traceFlags.toString(16).padStart(2, "0");
        return `00-${context.traceId}-${context.spanId}-${flags}`;
    }
    static inject(context, carrier) {
        carrier["traceparent"] = this.formatTraceParent(context);
        if (context.traceState) {
            carrier["tracestate"] = context.traceState;
        }
    }
    static extract(carrier) {
        const rawTp = carrier["traceparent"] || carrier["TRACEPARENT"];
        const tp = Array.isArray(rawTp) ? rawTp[0] : rawTp;
        const rawTs = carrier["tracestate"] || carrier["TRACESTATE"];
        const ts = Array.isArray(rawTs) ? rawTs[0] : rawTs;
        const ctx = this.parseTraceParent(tp);
        if (ctx && ts)
            ctx.traceState = ts;
        return ctx;
    }
}
export class Span {
    context;
    parentSpanId;
    name;
    kind;
    startTimeEpochMs;
    endTimeEpochMs;
    status = { code: "UNSET" };
    attributes = {};
    events = [];
    links = [];
    tracer;
    constructor(tracer, name, context, parentSpanId, kind = "INTERNAL", attributes = {}) {
        this.tracer = tracer;
        this.name = name;
        this.context = context;
        this.parentSpanId = parentSpanId;
        this.kind = kind;
        this.startTimeEpochMs = Date.now();
        this.setAttributes(attributes);
    }
    setAttribute(key, value) {
        const sanitized = sanitizeAttributes({ [key]: value });
        Object.assign(this.attributes, sanitized);
        return this;
    }
    setAttributes(attributes) {
        const sanitized = sanitizeAttributes(attributes);
        Object.assign(this.attributes, sanitized);
        return this;
    }
    addEvent(name, attributes = {}) {
        this.events.push({
            name,
            timeEpochMs: Date.now(),
            attributes: sanitizeAttributes(attributes),
        });
        return this;
    }
    addLink(link) {
        this.links.push({
            context: link.context,
            attributes: link.attributes ? sanitizeAttributes(link.attributes) : undefined,
        });
        return this;
    }
    setStatus(code, message) {
        this.status = { code, message };
        if (code === "ERROR") {
            this.attributes["error"] = true;
            if (message) {
                this.attributes["error.message"] = sanitizeError(message);
            }
        }
        return this;
    }
    recordException(err) {
        this.setStatus("ERROR", err instanceof Error ? err.message : String(err));
        this.addEvent("exception", {
            "exception.type": err instanceof Error ? err.name : typeof err,
            "exception.message": sanitizeError(err),
            "exception.stacktrace": err instanceof Error && err.stack ? sanitizeError(err.stack) : "",
        });
        return this;
    }
    end() {
        if (this.endTimeEpochMs)
            return;
        this.endTimeEpochMs = Date.now();
        this.tracer.recordSpanEnd(this);
    }
    toReadableSpan() {
        return {
            name: this.name,
            kind: this.kind,
            context: { ...this.context },
            parentSpanId: this.parentSpanId,
            startTimeEpochMs: this.startTimeEpochMs,
            endTimeEpochMs: this.endTimeEpochMs,
            durationMs: (this.endTimeEpochMs ?? Date.now()) - this.startTimeEpochMs,
            status: { ...this.status },
            attributes: { ...this.attributes },
            events: [...this.events],
            links: [...this.links],
            resource: { ...this.tracer.resource },
        };
    }
}
export class InMemorySpanExporter {
    spans = [];
    export(spans) {
        this.spans.push(...spans);
    }
    getFinishedSpans() {
        return this.spans;
    }
    reset() {
        this.spans = [];
    }
}
export class OtlpHttpSpanExporter {
    endpoint;
    constructor(endpoint) {
        const raw = endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
        this.endpoint = raw.endsWith("/v1/traces") ? raw : `${raw.replace(/\/$/, "")}/v1/traces`;
    }
    async export(spans) {
        if (spans.length === 0)
            return;
        const payload = {
            resourceSpans: [
                {
                    resource: {
                        attributes: Object.entries(spans[0]?.resource || {}).map(([key, value]) => ({
                            key,
                            value: { stringValue: String(value) },
                        })),
                    },
                    scopeSpans: [
                        {
                            scope: { name: "streampay", version: "0.1.0" },
                            spans: spans.map((s) => ({
                                traceId: s.context.traceId,
                                spanId: s.context.spanId,
                                parentSpanId: s.parentSpanId || "",
                                name: s.name,
                                kind: s.kind === "CONSUMER" ? 5 : s.kind === "SERVER" ? 2 : 1,
                                startTimeUnixNano: String(BigInt(s.startTimeEpochMs) * 1000000n),
                                endTimeUnixNano: String(BigInt(s.endTimeEpochMs || s.startTimeEpochMs) * 1000000n),
                                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                                    key,
                                    value: typeof value === "boolean"
                                        ? { boolValue: value }
                                        : typeof value === "number"
                                            ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
                                            : { stringValue: String(value) },
                                })),
                                status: {
                                    code: s.status.code === "OK" ? 1 : s.status.code === "ERROR" ? 2 : 0,
                                    message: s.status.message || "",
                                },
                                links: s.links.map((link) => ({
                                    traceId: link.context.traceId,
                                    spanId: link.context.spanId,
                                    attributes: link.attributes
                                        ? Object.entries(link.attributes).map(([k, v]) => ({
                                            key: k,
                                            value: { stringValue: String(v) },
                                        }))
                                        : [],
                                })),
                            })),
                        },
                    ],
                },
            ],
        };
        try {
            await fetch(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            }).catch(() => { });
        }
        catch { }
    }
}
export class Tracer {
    serviceName;
    resource;
    exporters = [];
    activeSpan = null;
    constructor(options) {
        this.serviceName = options.serviceName;
        this.resource = {
            "service.name": options.serviceName,
            "service.version": "0.1.0",
            ...options.resource,
        };
        if (options.exporters)
            this.exporters.push(...options.exporters);
    }
    addExporter(exporter) {
        this.exporters.push(exporter);
    }
    startSpan(name, options = {}) {
        let parentCtx = null;
        let parentSpanId = undefined;
        if (options.parent instanceof Span) {
            parentCtx = options.parent.context;
            parentSpanId = options.parent.context.spanId;
        }
        else if (options.parent) {
            parentCtx = options.parent;
            parentSpanId = options.parent.spanId;
        }
        else if (this.activeSpan) {
            parentCtx = this.activeSpan.context;
            parentSpanId = this.activeSpan.context.spanId;
        }
        const traceId = parentCtx ? parentCtx.traceId : generateTraceId();
        const spanId = generateSpanId();
        const traceFlags = parentCtx ? parentCtx.traceFlags : 1;
        const context = { traceId, spanId, traceFlags, traceState: parentCtx?.traceState };
        const span = new Span(this, name, context, parentSpanId, options.kind, options.attributes);
        if (options.links) {
            for (const link of options.links) {
                span.addLink(link);
            }
        }
        return span;
    }
    async withSpan(name, fn, options = {}) {
        const span = this.startSpan(name, options);
        const previous = this.activeSpan;
        this.activeSpan = span;
        try {
            const result = await fn(span);
            if (span.status.code === "UNSET")
                span.setStatus("OK");
            return result;
        }
        catch (err) {
            span.recordException(err);
            throw err;
        }
        finally {
            span.end();
            this.activeSpan = previous;
        }
    }
    recordSpanEnd(span) {
        const readable = span.toReadableSpan();
        for (const exporter of this.exporters) {
            try {
                void exporter.export([readable]);
            }
            catch { }
        }
    }
}
export const defaultIndexerTracer = new Tracer({
    serviceName: "streampay-indexer",
});
