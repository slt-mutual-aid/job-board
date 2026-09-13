import { describe, it, expect } from "vitest";
import {
  SourceResponseError,
  type ListingOnlyAdapter,
  type ListingThenDetailAdapter,
  type SourcePosting,
} from "./types";

// An ISO 8601 UTC calendar date. The type allows "" for a posting whose date
// the source does not carry, but a recorded listing that produces one means the
// date field moved, which is the failure this pattern is here to catch.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ABSOLUTE_HTTPS_URL = /^https:\/\/\S+$/;

export interface AdapterContractFixtures {
  // A recorded listing carrying at least one posting at the configured location.
  listing: string;
  // A well-formed listing whose postings are all somewhere else.
  farLocation: string;
  // A well-formed listing that genuinely carries nothing.
  empty: string;
  // The recorded listing cut off part way through.
  truncated: string;
  // The recorded listing with the container the parser reads renamed.
  renamedContainer: string;
}

interface ListingOnlyCase<Config> {
  adapter: ListingOnlyAdapter<Config>;
  config: Config;
  fixtures: AdapterContractFixtures;
}

interface ListingThenDetailCase<Config, Entry> {
  adapter: ListingThenDetailAdapter<Config, Entry>;
  config: Config;
  fixtures: AdapterContractFixtures;
  // A recorded detail response for the entry.
  detailFor(entry: Entry): string;
}

export function describeAdapterContract<Config>(
  testCase: ListingOnlyCase<Config>,
): string;
export function describeAdapterContract<Config, Entry>(
  testCase: ListingThenDetailCase<Config, Entry>,
): string;

// Returns the adapter id so a caller can prove every registered adapter reached
// this contract rather than only the ones somebody remembered to add.
export function describeAdapterContract<Config, Entry>(
  testCase: ListingOnlyCase<Config> | ListingThenDetailCase<Config, Entry>,
): string {
  const { adapter, config, fixtures } = testCase;
  const detailFor = "detailFor" in testCase ? testCase.detailFor : undefined;

  interface Reading {
    entryCount: number;
    confirmedEmpty: boolean;
    postings: SourcePosting[];
  }

  function read(raw: string): Reading {
    if (adapter.shape === "listing-only") {
      const { entries, confirmedEmpty } = adapter.parseListing(raw);
      return {
        entryCount: entries.length,
        confirmedEmpty,
        postings: adapter.selectLocal(entries, config),
      };
    }

    const { entries, confirmedEmpty } = adapter.parseListing(raw);
    if (detailFor === undefined) {
      throw new Error(`The ${adapter.id} contract case carries no detailFor`);
    }
    const postings = adapter
      .selectLocal(entries, config)
      .map((entry) => adapter.parseDetail(detailFor(entry), entry));
    return { entryCount: entries.length, confirmedEmpty, postings };
  }

  describe(`${adapter.id} adapter contract`, () => {
    it("builds postings a consumer can read from the recorded listing", () => {
      const { postings } = read(fixtures.listing);

      expect(postings.length).toBeGreaterThan(0);
      for (const posting of postings) {
        expect(posting.title).not.toBe("");
        expect(posting.location).not.toBe("");
        expect(posting.applyLink).toMatch(ABSOLUTE_HTTPS_URL);
        expect(posting.postedAt).toMatch(ISO_DATE);
      }
    });

    it("carries a liveness signal only where the source publishes one", () => {
      const { postings } = read(fixtures.listing);

      for (const { liveness } of postings) {
        if (liveness === undefined) {
          continue;
        }
        expect(liveness.status).not.toBe("");
        expect(typeof liveness.isOpen).toBe("boolean");
      }
    });

    it("selects nothing from a listing whose postings are all elsewhere", () => {
      const { entryCount, postings } = read(fixtures.farLocation);

      // A fixture that parsed to nothing would pass the next line without
      // exercising the location rule at all.
      expect(entryCount).toBeGreaterThan(0);
      expect(postings).toEqual([]);
    });

    it("reports an empty listing as empty rather than throwing", () => {
      const { entryCount, confirmedEmpty, postings } = read(fixtures.empty);

      expect(confirmedEmpty).toBe(true);
      expect(entryCount).toBe(0);
      expect(postings).toEqual([]);
    });

    it("throws on a truncated response rather than reading it as empty", () => {
      expect(() => read(fixtures.truncated)).toThrow(SourceResponseError);
    });

    it("throws when the container it reads is renamed", () => {
      expect(() => read(fixtures.renamedContainer)).toThrow(
        SourceResponseError,
      );
    });
  });

  return adapter.id;
}
