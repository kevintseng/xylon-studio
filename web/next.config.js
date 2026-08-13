/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
  env: {
    API_URL: process.env.API_URL || 'http://127.0.0.1:5001',
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL || 'http://127.0.0.1:5001'}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
