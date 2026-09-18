import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev badge renders over the demo stage's act title at /demo. Compile and
  // runtime errors still surface without it.
  devIndicators: false,
};

export default nextConfig;
