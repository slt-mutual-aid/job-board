import { defineConfig } from "vitest/config";

// Every project sets its own options. Vitest resolves each entry of `projects`
// from that entry alone, so anything declared alongside `projects` is ignored.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "src",
          globals: true,
          include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          environment: "jsdom",
          setupFiles: "./src/test/setup.ts",
          // Pin a timezone west of UTC so date rendering does not depend on the
          // machine running the suite.
          env: { TZ: "America/Los_Angeles" },
        },
      },
      {
        // The scripts run under Node. jsdom would supply a DOM production does
        // not have, and the src setup file pulls in browser-only matchers.
        test: {
          name: "scripts",
          globals: true,
          include: ["scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          environment: "node",
          // A date bug that shifts dates back one day is invisible in UTC, so the
          // scripts tests run in a zone west of UTC.
          env: { TZ: "America/Los_Angeles" },
        },
      },
    ],
  },
});
