/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Mongoose and the AWS SDK are server-only and must not be traced into the
  // client bundle. Keeping them external also keeps cold starts down.
  serverExternalPackages: ['mongoose', '@node-rs/argon2', 'bullmq', 'ioredis', 'pino'],

  experimental: {
    optimizePackageImports: ['lucide-react', 'date-fns', 'recharts'],
  },

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.amazonaws.com' },
      { protocol: 'https', hostname: '**.r2.cloudflarestorage.com' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
