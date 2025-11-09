/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['@i-am-bee/acp-sdk'],
  },
};

export default nextConfig;
