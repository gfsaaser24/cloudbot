import { Hono } from "hono";
import { GET as healthGet } from "./health/route.js";
import invitesVerifyRoute from "./invites/verify/route.js";

const unprotectedApiRouter = new Hono()
  .get("/health", healthGet)
  .route("/invites/verify", invitesVerifyRoute);

export { unprotectedApiRouter };
export type UnprotectedApiType = typeof unprotectedApiRouter;
