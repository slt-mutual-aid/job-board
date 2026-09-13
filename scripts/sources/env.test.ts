import { describe, it, expect } from "vitest";

// Adapters run under Node, not in a browser. The default vitest environment for
// this repo is jsdom, which supplies a DOM that production never has; a parser
// that accidentally reaches for `document` would pass its tests and fail on a
// real run.
describe("scripts test environment", () => {
  it("runs without a DOM", () => {
    expect(typeof document).toBe("undefined");
  });
});
