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
};

export default nextConfig;
