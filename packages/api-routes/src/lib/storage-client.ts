import { AwsClient } from "aws4fetch";

/**
 * Cloudflare R2 Storage client.
 *
 * - Direct operations (download, upload, delete) use the R2 bucket binding.
 * - Signed URL generation uses the S3-compatible API with credentials,
 *   since R2 bindings do not support presigning. aws4fetch is used instead
 *   of the AWS SDK to keep the Worker bundle small.
 */
export class StorageClient {
  // ── Signed URL operations (S3-compatible API) ──────────────────────

  private static awsClient: AwsClient | null = null;

  private static getAwsClient(): AwsClient {
    if (!StorageClient.awsClient) {
      const accessKeyId = process.env.CLOUDFLARE_ACCESS_KEY_ID;
      const secretAccessKey = process.env.CLOUDFLARE_SECRET_ACCESS_KEY;

      if (!process.env.R2_ENDPOINT || !accessKeyId || !secretAccessKey) {
        throw new Error(
          "R2_ENDPOINT, CLOUDFLARE_ACCESS_KEY_ID, and CLOUDFLARE_SECRET_ACCESS_KEY environment variables are required for signed URLs",
        );
      }

      StorageClient.awsClient = new AwsClient({
        accessKeyId,
        secretAccessKey,
        service: "s3",
        region: "auto",
      });
    }

    return StorageClient.awsClient;
  }

  private static async sign({
    method,
    bucket,
    key,
    expiresIn,
    headers,
  }: {
    method: "GET" | "PUT";
    bucket: string;
    key: string;
    expiresIn: number;
    headers?: Record<string, string>;
  }): Promise<string> {
    const path = key.split("/").map(encodeURIComponent).join("/");
    const url = new URL(`${process.env.R2_ENDPOINT}/${bucket}/${path}`);
    url.searchParams.set("X-Amz-Expires", String(expiresIn));

    const signed = await StorageClient.getAwsClient().sign(url.toString(), {
      method,
      headers,
      // Sign Content-Type and Content-Length too, so uploads must match them.
      aws: { signQuery: true, allHeaders: true },
    });

    return signed.url;
  }

  static async getSignedUrlForUpload({
    bucket,
    key,
    contentType,
    contentLength,
  }: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<{ url: string }> {
    const url = await StorageClient.sign({
      method: "PUT",
      bucket,
      key,
      expiresIn: 65,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(contentLength),
      },
    });

    return { url };
  }

  static async getSignedUrlForDownload({
    bucket,
    key,
  }: {
    bucket: string;
    key: string;
  }): Promise<string> {
    return StorageClient.sign({
      method: "GET",
      bucket,
      key,
      expiresIn: 180 * 60, // 3 hours
    });
  }
}
