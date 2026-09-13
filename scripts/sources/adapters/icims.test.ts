import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import {
  boardLinkPostingId,
  listingUrl,
  parseListing,
  selectLocal,
  IcimsResponseError,
  type IcimsConfig,
} from "./icims";

const ovgConfig: IcimsConfig = {
  host: "careers-ovg.icims.com",
  searchZip: "96150",
  searchRadiusMiles: 20,
  linkHosts: ["careers-ovg.icims.com"],
  locations: ["US-NV-Stateline"],
};

const davidsonConfig: IcimsConfig = {
  host: "careers-davidsonhospitality.icims.com",
  searchZip: "96150",
  searchRadiusMiles: 20,
  linkHosts: [
    "careers-davidsonhospitality.icims.com",
    "jobs-davidsonhospitality.icims.com",
  ],
  locations: ["US-CA-South Lake Tahoe"],
};

function fixture(name: string): string {
  return readFileSync(
    new URL(`../__fixtures__/${name}`, import.meta.url),
    "utf-8",
  );
}

const ovgListing = fixture("icims-ovg/listing.html.txt");
const davidsonListing = fixture("icims-davidson/listing.html.txt");

describe("listingUrl", () => {
  it("asks for the listing rather than the consent wrapper", () => {
    expect(listingUrl(ovgConfig)).toBe(
      "https://careers-ovg.icims.com/jobs/search?ss=1&searchZip=96150&searchRadius=20&in_iframe=1",
    );
  });
});

describe("parseListing", () => {
  it("maps every card in the recorded Oak View Group listing", () => {
    const { entries, confirmedEmpty } = parseListing(ovgListing);

    expect(confirmedEmpty).toBe(false);
    expect(entries).toHaveLength(6);
    expect(entries[0]).toEqual({
      id: "34623",
      title: "Box Office Ticket Seller | Part-Time | Tahoe Blue Event Center",
      location: "US-NV-Stateline",
      applyLink:
        "https://careers-ovg.icims.com/jobs/34623/box-office-ticket-seller-%7c-part-time-%7c-tahoe-blue-event-center/job",
      postedAt: "2026-09-03",
      commitment: "Regular Part-Time",
      department: "Box Office",
      description: expect.stringContaining("Box Office Ticket Seller"),
    });
  });

  it("maps every card in the recorded Davidson Hospitality listing", () => {
    const { entries } = parseListing(davidsonListing);

    expect(entries).toHaveLength(14);
    expect(entries[0]).toMatchObject({
      id: "28963",
      title: "Barista | Joe Merchant's Coffee & Provisions",
      location: "US-CA-South Lake Tahoe",
      applyLink:
        "https://careers-davidsonhospitality.icims.com/jobs/28963/barista-%7c-joe-merchant%27s-coffee-%26-provisions/job",
      department: "Food & Beverage",
    });
  });

  it("leaves the date empty for an account that publishes none", () => {
    for (const entry of parseListing(davidsonListing).entries) {
      expect(entry.postedAt).toBe("");
    }
  });

  it("drops the in_iframe parameter the embedded page links with", () => {
    for (const entry of parseListing(ovgListing).entries) {
      expect(entry.applyLink).not.toContain("in_iframe");
    }
  });

  it("leaves liveness absent because the listing reports no such signal", () => {
    for (const entry of parseListing(ovgListing).entries) {
      expect(entry.liveness).toBeUndefined();
    }
  });

  it("reads the recorded no-results page as genuinely empty", () => {
    for (const name of [
      "icims-ovg/empty.html.txt",
      "icims-davidson/empty.html.txt",
    ]) {
      expect(parseListing(fixture(name))).toEqual({
        entries: [],
        confirmedEmpty: true,
      });
    }
  });

  it("throws on the response a request without in_iframe=1 returns", () => {
    // The consent wrapper is a whole page of markup carrying no listing and no
    // job of any kind, and the one thing it never carries is the marker below.
    expect(() =>
      parseListing("<html><body>consent wrapper</body></html>"),
    ).toThrow(IcimsResponseError);
  });

  it("throws on a page carrying neither a job table nor the no-results text", () => {
    const withoutMessage = ovgListing
      .split("iCIMS_JobsTable")
      .join("iCIMS_JobsGrid");

    expect(() => parseListing(withoutMessage)).toThrow(IcimsResponseError);
  });

  it("throws rather than reading one page of several", () => {
    const paged = ovgListing.replace("Page 1 of 1", "Page 1 of 3");

    expect(() => parseListing(paged)).toThrow(/page 1 of 3/);
  });

  it("throws when a card carries no location field", () => {
    const relabelled = ovgListing
      .split("Location : Location")
      .join("Work Site");

    expect(() => parseListing(relabelled)).toThrow(IcimsResponseError);
  });

  it("throws when a labelled posted date stops carrying a date", () => {
    const undated = ovgListing.replace(
      '<span title="9/3/2026 2:30 PM">',
      "<span>",
    );

    expect(() => parseListing(undated)).toThrow(IcimsResponseError);
  });

  it("throws when a card links somewhere other than a posting page", () => {
    const rerouted = ovgListing.replace(
      "/jobs/34623/box-office-ticket-seller-%7c-part-time-%7c-tahoe-blue-event-center/job?in_iframe=1",
      "/connect?back=intro",
    );

    expect(() => parseListing(rerouted)).toThrow(IcimsResponseError);
  });
});

describe("selectLocal", () => {
  it("keeps the postings at the configured locations", () => {
    const { entries } = parseListing(ovgListing);

    expect(selectLocal(entries, ovgConfig)).toHaveLength(6);
  });

  it("drops a posting the radius search returned from elsewhere", () => {
    const { entries } = parseListing(davidsonListing);

    expect(selectLocal(entries, ovgConfig)).toEqual([]);
  });
});

describe("boardLinkPostingId", () => {
  it.each([
    [
      "https://careers-davidsonhospitality.icims.com/jobs/26309/housekeeping-room-attendant/job?hub=10",
      "26309",
    ],
    [
      "https://jobs-davidsonhospitality.icims.com/jobs/26309/housekeeping-room-attendant/job",
      "26309",
    ],
  ])("reads %s as posting %s", (link, postingId) => {
    expect(boardLinkPostingId(davidsonConfig, new URL(link))).toBe(postingId);
  });

  it.each([
    "https://careers-ovg.icims.com/jobs/26309/housekeeping-room-attendant/job",
    "https://careers-davidsonhospitality.icims.com/jobs/search?ss=1",
    "https://careers-davidsonhospitality.icims.com/jobs/26309/housekeeping-room-attendant",
  ])("reads %s as a link this account does not answer for", (link) => {
    expect(boardLinkPostingId(davidsonConfig, new URL(link))).toBeNull();
  });
});
