import { StorageClient } from "@workspace/api-routes/lib/storage-client.js";
import { createSignedUrlSchema } from "@workspace/api-routes/schemas/signed-url-schema.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type Variables } from "@workspace/api-routes/types/variables.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { fileTypeOf } from "@workspace/api-routes/lib/file-types.js";

const signedUrlSchema = createSignedUrlSchema([
  "text",
  "pdf",
  "image",
  "document",
]);

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().post(
  "/",
  validator("json", async (value, c) => {
    const parsed = signedUrlSchema.safeParse(value);
    if (!parsed.success) {
      // Check if the error is related to the filename field
      const filenameError = parsed.error.issues.find((issue) =>
        issue.path.includes("filename"),
      );
      if (filenameError) {
        throw new HTTPException(400, { message: "INVALID_FILENAME" });
      }
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }
    return parsed.data;
  }),
  async (c) => {
    const { filename, fileSize } = c.req.valid("json");
    // The schema only accepts known extensions, so this is never null.
    const contentType = fileTypeOf(filename)!.mimeType;
    const user = c.get("user");

    const key = `attachments/${user.id}/${filename}`;

    const { url: signedUrl } = await StorageClient.getSignedUrlForUpload({
      bucket: process.env.R2_BUCKET_NAME!,
      key,
      contentType,
      contentLength: fileSize,
    });

    return c.json({
      signedUrl,
      key,
      contentType,
    });
  },
);

export default app;
