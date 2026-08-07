import type { NextConfig } from "next";
import { version } from "./package.json";

const nextConfig: NextConfig = {
  /*
   * Surfaces the app version to the browser so the UI can display it.
   *
   * Read from package.json rather than kept in a second place: `npm version`
   * bumps it, and there is exactly one number to trust when a tester says
   * "it's broken" and you need to know what they were running. Baked in at
   * build time, so the deployed build reports the version it was built from.
   */
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },

  /*
   * @napi-rs/canvas is a native addon, not JavaScript the bundler can place in
   * an ESM chunk — the image classifier's API route fails to build without
   * this. Left to Node to require at runtime instead of being bundled.
   */
  serverExternalPackages: ['@napi-rs/canvas'],
};

export default nextConfig;
