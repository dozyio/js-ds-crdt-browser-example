/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  swcMinify: true,
  pageExtensions: ['page.tsx', 'page.ts'],
  output: 'export',
  images: {
    unoptimized: true,
  },
  trailingSlash: true
};

export default nextConfig;
