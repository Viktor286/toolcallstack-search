import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";

const DEFAULT_DIR = fileURLToPath(new URL("../../../dashboard/dist/", import.meta.url));

/**
 * The dashboard runs only its own scripts and talks only to the gateway, so an injected script
 * cannot run or send the stored API key anywhere. Inline styles stay allowed: Radix's scroll lock
 * inserts <style> tags.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Serves the built dashboard under /ui when it exists. The gateway works the
 * same without it; in development the dashboard runs on its own Vite server.
 */
export const uiRoutes: FastifyPluginAsync<{ dir?: string }> = async (app, options) => {
  const dir = options.dir ?? DEFAULT_DIR;
  if (!existsSync(`${dir}/index.html`)) {
    app.log.info("dashboard build not found: /ui is not served (run `pnpm build`)");
    return;
  }

  const hidden = { schema: { hide: true } };
  app.get("/", hidden, async (_request, reply) => reply.redirect("/ui/"));
  app.get("/ui", hidden, async (_request, reply) => reply.redirect("/ui/"));

  await app.register(
    async (ui) => {
      ui.addHook("onSend", async (_request, reply) => {
        reply.header("content-security-policy", CSP);
      });
      // Files are looked up per request, so a rebuilt dashboard is served without a restart.
      await ui.register(fastifyStatic, { root: dir, prefix: "/" });
      ui.setNotFoundHandler((request, reply) => {
        // Client-side routes such as /ui/calls have no file; the app's entry page handles
        // them. A missing asset is a real 404, not a page.
        const path = request.url.split("?")[0] ?? "";
        if (request.method !== "GET" || /\.[a-z0-9]+$/i.test(path)) {
          return reply.code(404).send({ error: { type: "not_found", message: "no such file" } });
        }
        return reply.sendFile("index.html");
      });
    },
    { prefix: "/ui" },
  );
};
