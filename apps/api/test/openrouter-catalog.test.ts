import { getOpenRouterCatalog } from "@workspace/api-routes/providers/openrouter-catalog.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The model menu and capability gating come from OpenRouter's catalog, read
// through its typed client SDK.

// Three real catalog entries: one with tools and tool_choice, one with tools
// only, one with neither.
const catalog = readFileSync(new URL("./fixtures/openrouter-models.json", import.meta.url), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("model catalog", () => {
  it("lists only models that support tools and tool_choice, with their parameters and output limit", async () => {
    const requested: string[] = [];
    const auth: (string | null)[] = [];
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubGlobal("fetch", async (input: Request | URL | string, init?: RequestInit) => {
      requested.push(input instanceof Request ? input.url : String(input));
      auth.push(input instanceof Request ? input.headers.get("Authorization") : new Headers(init?.headers).get("Authorization"));
      return new Response(catalog, { headers: { "Content-Type": "application/json" } });
    });

    const models = await getOpenRouterCatalog();

    expect(requested[0]).toContain("openrouter.ai/api/v1/models");
    // The models endpoint is public: no API key goes with it.
    expect(auth[0]).toBeNull();
    expect(models.map((m) => m.id)).toEqual(["openai/gpt-6-luna"]);
    expect(models[0]).toMatchObject({
      label: expect.any(String),
      images: true,
      pdfs: true,
      reasoning: true,
      contextLength: 1_050_000,
      maxCompletionTokens: 128_000,
      supportedParameters: expect.arrayContaining(["tools", "tool_choice", "max_tokens", "verbosity"]),
    });
  });

  // A fresh module, so no earlier test's cached catalog is served.
  const freshCatalog = async () => {
    vi.resetModules();
    return (await import("@workspace/api-routes/providers/openrouter-catalog.js")).getOpenRouterCatalog();
  };

  it("reads the next page when a full page has a model it leaves out", async () => {
    const listed = JSON.parse(catalog) as { data: Record<string, unknown>[] };
    const luna = listed.data[0]!;
    const fullPage = [
      ...Array.from({ length: 499 }, (_, i) => ({ ...luna, id: `copy/model-${i}` })),
      { ...luna, id: "broken/model", architecture: "not an object" },
    ];
    const offsets: (string | null)[] = [];
    vi.stubGlobal("fetch", async (input: Request | URL | string) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      offsets.push(url.searchParams.get("offset"));
      return Response.json({ data: url.searchParams.get("offset") === "0" ? fullPage : listed.data });
    });

    const models = await freshCatalog();

    expect(offsets).toEqual(["0", "500"]);
    expect(models).toHaveLength(500);
    expect(models.map((m) => m.id)).not.toContain("broken/model");
  });

  it("fails instead of listing no models when no entry matches the SDK", async () => {
    const listed = JSON.parse(catalog) as { data: Record<string, unknown>[] };
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: listed.data.map((m) => ({ ...m, architecture: "not an object" })) }),
    );

    await expect(freshCatalog()).rejects.toThrow();
  });

  it("leaves out only a model listed in a shape the SDK doesn't expect", async () => {
    const listed = JSON.parse(catalog) as { data: Record<string, unknown>[] };
    listed.data.push({ ...listed.data[0], id: "broken/model", architecture: "not an object" });
    vi.stubGlobal("fetch", async () => Response.json(listed));

    const models = await freshCatalog();

    expect(models.map((m) => m.id)).toEqual(["openai/gpt-6-luna"]);
  });
});
