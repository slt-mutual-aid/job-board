import { describe, it, expect } from "vitest";
import { UNKNOWN_DATE, isUnknownDate, getAllJobs, searchJobs } from "./db";
import type { Job } from "./db";

// Both sort paths promise the same ordering: every job with a real posted date
// comes before every job with the unknown-date sentinel. Asserting that no
// known date follows an unknown one holds whatever mix the committed
// jobboard.json happens to carry.
function expectUnknownDatesLast(jobs: Job[]): void {
  expect(jobs.length).toBeGreaterThan(0);

  let seenUnknown = false;
  for (const job of jobs) {
    if (isUnknownDate(job.posted_date)) {
      seenUnknown = true;
    } else {
      expect(seenUnknown).toBe(false);
    }
  }
}

describe("db", () => {
  describe("isUnknownDate", () => {
    it("returns true for UNKNOWN_DATE", () => {
      expect(isUnknownDate(UNKNOWN_DATE)).toBe(true);
    });

    it("returns false for regular dates", () => {
      expect(isUnknownDate(new Date().toISOString())).toBe(false);
      expect(isUnknownDate("2024-01-15T00:00:00.000Z")).toBe(false);
    });
  });

  describe("getAllJobs sorting with unknown dates", () => {
    it("sorts jobs with unknown dates at the end", () => {
      expectUnknownDatesLast(getAllJobs());
    });
  });

  describe("searchJobs sorting with unknown dates", () => {
    it("sorts filtered jobs with unknown dates at the end", () => {
      expectUnknownDatesLast(searchJobs("", {}));
    });
  });
});
