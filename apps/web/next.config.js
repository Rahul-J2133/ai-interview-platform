/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ["@interview/shared-types"],
  images: {
    remotePatterns: [{ hostname: "img.clerk.com" }, { hostname: "images.clerk.dev" }],
  },
};
