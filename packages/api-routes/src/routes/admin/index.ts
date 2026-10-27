import { Hono } from "hono";
import invitesByIdRoute from "./invites/[inviteId]/route.js";
import invitesRoute from "./invites/route.js";
import usersRoute from "./users/route.js";

const adminApiRouter = new Hono()
  .route("/invites", invitesRoute)
  .route("/invites/:inviteId", invitesByIdRoute)
  .route("/users", usersRoute);

export { adminApiRouter };
export type AdminApiType = typeof adminApiRouter;
