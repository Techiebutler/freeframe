/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async redirects() {
    return [{ source: '/o', destination: '/whop', permanent: false }]
  },
  // Only the video-only embed may be framed (Gen desk, customer portal); every other page stays unframable by default.
  async headers() {
    return [{
      source: '/share/:token',
      has: [{ type: 'query', key: 'embed', value: '1' }],
      headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors https://gen.aditor.ai https://app.aditor.ai' }],
    }]
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
      },
    ],
  },
}

module.exports = nextConfig
