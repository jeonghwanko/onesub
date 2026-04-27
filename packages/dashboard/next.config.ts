import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Required for the Docker image — Next.js produces a minimal standalone
  // server in `.next/standalone/` that runs without `node_modules` on disk.
  output: 'standalone',
  // Reduce noise: we don't ship images via next/image at this stage.
  images: { unoptimized: true },
  // Pin the workspace root so Next.js doesn't infer a parent directory's
  // package-lock.json (e.g. when the user has multiple repos under their
  // home dir). Resolves the "multiple lockfiles" warning at dev start.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
};

export default nextConfig;
