/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // sql.js ships a wasm binary; keep it out of the server bundle.
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    return config;
  },
};
export default nextConfig;
