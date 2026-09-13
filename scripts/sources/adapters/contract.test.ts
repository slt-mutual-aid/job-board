import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { describeAdapterContract } from "../adapter-contract";
import { bambooHrSource, leverSource, sources } from "../registry";

function fixture(path: string): string {
  return readFileSync(new URL(`../__fixtures__/${path}`, import.meta.url), {
    encoding: "utf-8",
  });
}

const leverListing = fixture("lever-insomnia/listing.json");
const bambooHrListing = fixture("bamboohr-vra/listing.json");
const bambooHrDetail = fixture("bamboohr-vra/detail-32.json");

function leverAtFarLocation(): string {
  const decoded = JSON.parse(leverListing) as Array<{
    categories: { location: string };
  }>;
  for (const posting of decoded) {
    posting.categories.location = "Reno NV";
  }
  return JSON.stringify(decoded);
}

function leverUnderRenamedContainer(): string {
  return JSON.stringify({ postings: JSON.parse(leverListing) });
}

function bambooHrAtFarLocation(): string {
  const decoded = JSON.parse(bambooHrListing) as {
    result: Array<{ location: { city: string } }>;
  };
  for (const entry of decoded.result) {
    entry.location.city = "Reno";
  }
  return JSON.stringify(decoded);
}

function bambooHrUnderRenamedContainer(): string {
  const decoded = JSON.parse(bambooHrListing) as Record<string, unknown>;
  decoded.jobs = decoded.result;
  delete decoded.result;
  return JSON.stringify(decoded);
}

const contracted = [
  describeAdapterContract({
    ...leverSource,
    fixtures: {
      listing: leverListing,
      farLocation: leverAtFarLocation(),
      empty: fixture("lever-insomnia/empty.json"),
      truncated: leverListing.slice(0, 5000),
      renamedContainer: leverUnderRenamedContainer(),
    },
  }),
  describeAdapterContract({
    ...bambooHrSource,
    fixtures: {
      listing: bambooHrListing,
      farLocation: bambooHrAtFarLocation(),
      // BambooHR publishes no recorded empty listing, so the shape of one is
      // written out: a total of zero agreeing with zero entries.
      empty: '{"meta":{"totalCount":0},"result":[]}',
      truncated: bambooHrListing.slice(0, 900),
      renamedContainer: bambooHrUnderRenamedContainer(),
    },
    // parseDetail takes identity, title, and location from the listing entry,
    // so one recorded detail body stands in for every selected entry.
    detailFor: () => bambooHrDetail,
  }),
];

describe("adapter contract coverage", () => {
  it("holds every adapter in the registry to the contract", () => {
    expect([...contracted].sort()).toEqual(
      sources.map((source) => source.adapter.id).sort(),
    );
  });
});
