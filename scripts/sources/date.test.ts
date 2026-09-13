import { describe, it, expect } from "vitest";
import { toSpreadsheetDate } from "./date";

// A local-time shift is invisible under TZ=UTC, so vitest.config.ts pins the
// scripts project to America/Los_Angeles. The first test fails loudly if that
// pin stops working.
describe("toSpreadsheetDate", () => {
  it("runs under America/Los_Angeles", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/Los_Angeles",
    );
  });

  it("keeps the UTC calendar date just after UTC midnight", () => {
    expect(toSpreadsheetDate("2026-07-12T00:30:00.000Z")).toBe("7/12/2026");
  });

  it("keeps the UTC calendar date just before UTC midnight", () => {
    expect(toSpreadsheetDate("2026-07-11T23:59:59.999Z")).toBe("7/11/2026");
  });

  it("keeps the UTC calendar date at UTC midnight", () => {
    expect(toSpreadsheetDate("2026-07-11T00:00:00.000Z")).toBe("7/11/2026");
  });

  it("keeps the UTC calendar date across a new year", () => {
    expect(toSpreadsheetDate("2027-01-01T00:15:00.000Z")).toBe("1/1/2027");
  });

  it("pads neither the month nor the day", () => {
    expect(toSpreadsheetDate("2026-01-05T12:00:00.000Z")).toBe("1/5/2026");
  });

  it("accepts a date without a time", () => {
    expect(toSpreadsheetDate("2026-07-11")).toBe("7/11/2026");
  });

  it("resolves a numeric offset to UTC", () => {
    expect(toSpreadsheetDate("2026-07-12T01:00:00+02:00")).toBe("7/11/2026");
  });

  it("returns an empty string for a timestamp carrying no zone", () => {
    expect(toSpreadsheetDate("2026-07-11T00:00:00")).toBe("");
  });

  it("returns an empty string for a date that does not exist", () => {
    expect(toSpreadsheetDate("2026-13-45T00:00:00.000Z")).toBe("");
  });

  it("returns an empty string for text that is not a timestamp", () => {
    expect(toSpreadsheetDate("Ongoing")).toBe("");
  });

  it("returns an empty string for an empty input", () => {
    expect(toSpreadsheetDate("")).toBe("");
  });
});
