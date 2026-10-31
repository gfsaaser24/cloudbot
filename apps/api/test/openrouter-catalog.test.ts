import { getOpenRouterCatalog } from "@workspace/api-routes/providers/openrouter-catalog.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The model menu and capability gating come from OpenRouter's catalog, read
// through its typed client SDK.

// Three real catalog entries: one with tools and tool_choice, one with tools
// only, one with neither.
const catalog = readFileSync(new URL("./fixtures/openrouter-models.json", import.meta.url), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("model catalog", () => {
  it("lists only models that support tools and tool_choice, with their parameters and output limit", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: Request | URL | string) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return new Response(catalog, { headers: { "Content-Type": "application/json" } });
    });

    const models = await getOpenRouterCatalog();

    expect(requested[0]).toContain("openrouter.ai/api/v1/models");
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
});
