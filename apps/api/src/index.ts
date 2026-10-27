import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import app from "./app.js";

type Env = Bindings & { ASSETS: Fetcher };

// One Worker serves everything on one hostname:
//   /api/*        -> Hono API
//   /dashboard/*  -> admin dashboard (static export of apps/dashboard)
//   everything    -> chat app (static export of apps/web)
// Static files come from the assets binding; HTML pages get a per-request CSP nonce.

const LOCALES = ["en", "de"];
const DEFAULT_LOCALE = "en";
const DASHBOARD = "/dashboard";

function pickLocale(acceptLanguage: string | null): string {
  for (const part of (acceptLanguage ?? "").split(",")) {
    const language = part.split(";")[0]!.trim().toLowerCase().split("-")[0]!;
    if (LOCALES.includes(language)) {
      return language;
    }
  }
  return DEFAULT_LOCALE;
}

// Returns a redirect for pages without a locale prefix (e.g. "/" or "/dashboard/admin/users").
function localeRedirect(request: Request, url: URL): Response | null {
  const inDashboard =
    url.pathname === DASHBOARD || url.pathname.startsWith(`${DASHBOARD}/`);
  const base = inDashboard ? DASHBOARD : "";
  const rest = url.pathname.slice(base.length) || "/";
  const firstSegment = rest.split("/")[1] ?? "";
  const lastSegment = rest.split("/").pop() ?? "";

  // Files such as /favicon.ico or RSC payloads (*.txt) are served as-is.
  if (lastSegment.includes(".")) {
    return null;
  }

  if (LOCALES.includes(firstSegment)) {
    // The dashboard has no locale index page: /dashboard/en -> /dashboard/en/admin/users
    if (inDashboard && rest.replace(/\/$/, "") === `/${firstSegment}`) {
      return Response.redirect(
        `${url.origin}${DASHBOARD}/${firstSegment}/admin/users${url.search}`,
        302,
      );
    }
    return null;
  }

  const locale = pickLocale(request.headers.get("Accept-Language"));
  const target = `${base}/${locale}${rest === "/" ? "" : rest}`;
  return Response.redirect(`${url.origin}${target}${url.search}`, 302);
}

function contentSecurityPolicy(nonce: string): string {
  const r2 = process.env.R2_ENDPOINT ?? "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https: http:`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: https://www.google.com https://*.gstatic.com",
    "font-src 'self'",
    "object-src 'self'",
    `frame-src 'self' blob: data: ${r2}`,
    `connect-src 'self' ${r2}`,
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);

  if (!response.headers.get("Content-Type")?.includes("text/html")) {
    return response;
  }

  const nonce = newNonce();
  const addNonce = {
    element(element: Element) {
      element.setAttribute("nonce", nonce);
    },
  };
  // Script preloads are checked against script-src too, so they need the nonce as well.
  const rewritten = new HTMLRewriter()
    .on("script", addNonce)
    .on('link[rel="preload"][as="script"], link[rel="modulepreload"]', addNonce)
    .transform(response);

  const withCsp = new Response(rewritten.body, rewritten);
  withCsp.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  return withCsp;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }

    return localeRedirect(request, url) ?? serveAsset(request, env);
  },
};
