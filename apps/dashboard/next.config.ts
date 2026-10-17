import type { NextConfig } from 'next';

// The browser only talks to the dashboard origin; /api/* is proxied to the NestJS API.
// That keeps the httpOnly refresh cookie first-party in dev and in production.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_INTERNAL_URL}/:path*` }];
  },
};

export default nextConfig;
