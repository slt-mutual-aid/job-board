import { describe, it, expect } from "vitest";
import { parseDate } from "./import-csv";

// A date built in local time and serialized as UTC shifts back one day in every
// zone west of UTC, and that shift is invisible under TZ=UTC. vitest.config.ts
// pins the scripts project to America/Los_Angeles so the assertion below has
// something to catch; the first test fails loudly if that pin stops working.
describe("parseDate", () => {
  it("runs under America/Los_Angeles", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/Los_Angeles",
    );
  });

  it("returns midnight UTC for a MM/DD/YYYY date", () => {
    expect(parseDate("7/11/2026")).toBe("2026-07-11T00:00:00.000Z");
  });
});
