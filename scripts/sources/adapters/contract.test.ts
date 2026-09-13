import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { describeAdapterContract } from "../adapter-contract";
import {
  bambooHrSource,
  icimsDavidsonSource,
  icimsOvgSource,
  leverSource,
  sources,
} from "../registry";

function fixture(path: string): string {
  return readFileSync(new URL(`../__fixtures__/${path}`, import.meta.url), {
    encoding: "utf-8",
  });
}

const leverListing = fixture("lever-insomnia/listing.json");
const bambooHrListing = fixture("bamboohr-vra/listing.json");
const bambooHrDetail = fixture("bamboohr-vra/detail-32.json");
const icimsOvgListing = fixture("icims-ovg/listing.html");
const icimsDavidsonListing = fixture("icims-davidson/listing.html");

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

// The location is written into the card as text, so a listing from somewhere
// else is the recorded one with that text replaced.
function icimsAtFarLocation(listing: string, location: string): string {
  return listing.split(location).join("US-NV-Reno");
}

// The parser finds the job table by the one class name, so renaming it is what
// a redesign of the listing looks like from here.
function icimsUnderRenamedContainer(listing: string): string {
  return listing.split("iCIMS_JobsTable").join("iCIMS_JobsGrid");
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
    ...icimsOvgSource,
    fixtures: {
      listing: icimsOvgListing,
      farLocation: icimsAtFarLocation(icimsOvgListing, "US-NV-Stateline"),
      empty: fixture("icims-ovg/empty.html"),
      // Cut after the page header and before the job table closes, which is
      // the read that would otherwise report a page of postings as a few.
      truncated: icimsOvgListing.slice(0, 50000),
      renamedContainer: icimsUnderRenamedContainer(icimsOvgListing),
    },
  }),
  describeAdapterContract({
    ...icimsDavidsonSource,
    fixtures: {
      listing: icimsDavidsonListing,
      farLocation: icimsAtFarLocation(
        icimsDavidsonListing,
        "US-CA-South Lake Tahoe",
      ),
      empty: fixture("icims-davidson/empty.html"),
      truncated: icimsDavidsonListing.slice(0, 45000),
      renamedContainer: icimsUnderRenamedContainer(icimsDavidsonListing),
      // The Davidson account publishes no posted date on a card or on a
      // posting page, and a date invented here would reach a job seeker as
      // fact.
      carriesPostedAt: false,
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
  it("holds every source in the registry to the contract", () => {
    expect([...contracted].sort()).toEqual(
      sources.map((source) => source.sourceId).sort(),
    );
  });
});
