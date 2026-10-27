/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export under /dashboard: served as Workers static assets by the API Worker (apps/api).
  // The /dashboard/<lang> -> /dashboard/<lang>/admin/users redirect lives in apps/api/src/unified.ts.
  output: "export",
  basePath: "/dashboard",
  images: { unoptimized: true },
  transpilePackages: ["@workspace/ui"],
};

export default nextConfig;
