/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: served as Workers static assets by the API Worker (apps/api).
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@workspace/ui"],
};

export default nextConfig;
