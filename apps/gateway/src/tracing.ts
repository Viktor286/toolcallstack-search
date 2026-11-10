import { FastifyOtelInstrumentation } from "@fastify/otel";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { VERSION } from "./version.ts";

export const TRACER_NAME = "toolcallstack-search";

/** Spans are created through the global API, which does nothing until tracing is started. */
export const tracer = () => trace.getTracer(TRACER_NAME, VERSION);

export interface Tracing {
  /** Fastify plugin that opens a span per request and continues an incoming `traceparent`. */
  plugin: ReturnType<FastifyOtelInstrumentation["plugin"]>;
  /** Flush what is buffered and stop exporting. */
  shutdown(): Promise<void>;
}

/**
 * Export OpenTelemetry traces when an OTLP endpoint is configured through the
 * standard `OTEL_EXPORTER_OTLP_ENDPOINT` (or `..._TRACES_ENDPOINT`) variable;
 * otherwise tracing stays off and costs nothing. Every search becomes a span
 * under the caller's trace, with one child span per upstream attempt.
 */
export function startTracing(
  env: Record<string, string | undefined>,
  options: { exporter?: SpanExporter } = {},
): Tracing | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (env.OTEL_SDK_DISABLED === "true" || (!endpoint && !options.exporter)) return null;

  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME ?? TRACER_NAME,
      "service.version": VERSION,
    }),
    spanProcessors: [
      // A test exporter is read right after the request, so it must not be batched.
      options.exporter
        ? new SimpleSpanProcessor({ exporter: options.exporter })
        : new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const instrumentation = new FastifyOtelInstrumentation({
    // One span per request is enough; a span per lifecycle hook buries the search spans.
    instrumentHooks: false,
    ignorePaths: (route) => ["/health", "/ready", "/metrics"].includes(route.url),
  });
  instrumentation.setTracerProvider(provider);

  return {
    plugin: instrumentation.plugin(),
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
