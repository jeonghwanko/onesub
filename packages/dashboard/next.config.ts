import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Required for the Docker image — Next.js produces a minimal standalone
  // server in `.next/standalone/` that runs without `node_modules` on disk.
  output: 'standalone',
  // Reduce noise: we don't ship images via next/image at this stage.
  images: { unoptimized: true },
};

export default nextConfig;
