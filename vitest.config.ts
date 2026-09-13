import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Pin a timezone west of UTC so date rendering does not depend on the machine running the suite.
    env: { TZ: "America/Los_Angeles" },
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});
