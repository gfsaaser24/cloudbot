import { getOpenRouterCatalog } from "@workspace/api-routes/providers/openrouter-catalog.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type Variables } from "@workspace/api-routes/types/variables.js";
import { Hono } from "hono";

// Chat models the user can pick from (every tool-capable OpenRouter model).
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().get(
  "/",
  async (c) => {
    return c.json(await getOpenRouterCatalog());
  },
);

export default app;
