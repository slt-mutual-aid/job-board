import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import {
  createOracleAdapter,
  listingUrl,
  postingUrl,
  selectLocal,
  OracleResponseError,
  type OracleConfig,
} from "./oracle";
import type { SourcePosting } from "../types";

const config: OracleConfig = {
  host: "edmn.fa.us2.oraclecloud.com",
  siteNumber: "CX_1",
  locationFacet: "300000002323814",
  location: "South Lake Tahoe, NV, United States",
};

const adapter = createOracleAdapter(config);

function fixture(name: string): string {
  return readFileSync(
    new URL(`../__fixtures__/oracle-caesars/${name}`, import.meta.url),
    "utf-8",
  );
}

const listing = fixture("listing.json");
const empty = fixture("empty.json");

interface OracleResponse {
  items: Array<{
    TotalJobsCount: number;
    requisitionList: Array<Record<string, unknown>>;
  }>;
}

function rewrite(change: (decoded: OracleResponse) => void): string {
  const decoded = JSON.parse(listing) as OracleResponse;
  change(decoded);
  return JSON.stringify(decoded);
}

describe("listingUrl", () => {
  it("leaves the finder separators unencoded", () => {
    expect(listingUrl(config)).toBe(
      "https://edmn.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_1,limit=200,sortBy=POSTING_DATES_DESC,selectedLocationsFacet=300000002323814",
    );
  });
});

describe("parseListing", () => {
  it("maps every requisition in the recorded listing", () => {
    const { entries, confirmedEmpty } = adapter.parseListing(listing);

    expect(confirmedEmpty).toBe(false);
    expect(entries).toHaveLength(73);
    expect(entries[0]).toMatchObject({
      id: "87812",
      title: "Bar Prep - Wolf by Vanderpump",
      location: "South Lake Tahoe, NV, United States",
      applyLink:
        "https://edmn.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/87812/",
      postedAt: "2026-09-12",
    });
  });

  it("leaves liveness and description absent because the listing carries neither", () => {
    for (const entry of adapter.parseListing(listing).entries) {
      expect(entry.liveness).toBeUndefined();
      expect(entry.description).toBeUndefined();
    }
  });

  it("carries a closing date where the requisition states one", () => {
    const raw = rewrite((decoded) => {
      decoded.items[0].requisitionList[0].PostingEndDate = "2026-10-31";
    });

    expect(adapter.parseListing(raw).entries[0].closesAt).toBe("2026-10-31");
  });

  it("leaves the closing date absent where the requisition writes null", () => {
    expect(adapter.parseListing(listing).entries[0].closesAt).toBeUndefined();
  });

  it("reads a zero total as a confirmed empty listing", () => {
    const { entries, confirmedEmpty } = adapter.parseListing(empty);

    expect(entries).toEqual([]);
    expect(confirmedEmpty).toBe(true);
  });

  it("throws when the requisition count disagrees with TotalJobsCount", () => {
    const raw = rewrite((decoded) => {
      decoded.items[0].requisitionList.pop();
    });

    expect(() => adapter.parseListing(raw)).toThrow(OracleResponseError);
    expect(() => adapter.parseListing(raw)).toThrow(
      /carries 72 requisitions and reports TotalJobsCount 73/,
    );
  });

  it("throws when a truncated page reports more than it returns", () => {
    const raw = rewrite((decoded) => {
      decoded.items[0].TotalJobsCount = 500;
    });

    expect(() => adapter.parseListing(raw)).toThrow(OracleResponseError);
  });

  it("throws when TotalJobsCount is not a whole number", () => {
    const raw = rewrite((decoded) => {
      decoded.items[0].TotalJobsCount = "73" as unknown as number;
    });

    expect(() => adapter.parseListing(raw)).toThrow(OracleResponseError);
  });

  it("throws on a response carrying no search result", () => {
    const raw = rewrite((decoded) => {
      decoded.items = [];
    });

    expect(() => adapter.parseListing(raw)).toThrow(OracleResponseError);
  });

  it("throws on a response that is not an Oracle listing", () => {
    expect(() => adapter.parseListing("[]")).toThrow(OracleResponseError);
    expect(() => adapter.parseListing("not json")).toThrow(OracleResponseError);
  });

  it("throws when a requisition loses the field the board row needs", () => {
    const raw = rewrite((decoded) => {
      delete decoded.items[0].requisitionList[0].Title;
    });

    expect(() => adapter.parseListing(raw)).toThrow(OracleResponseError);
  });
});

describe("selectLocal", () => {
  it("drops the neighbouring towns the location facet also carries", () => {
    const entries = adapter.parseListing(listing).entries;
    const selected = selectLocal(entries, config);

    expect(entries.length).toBeGreaterThan(selected.length);
    for (const posting of selected) {
      expect(posting.location).toBe(config.location);
    }
  });

  it("keeps nothing when every requisition is somewhere else", () => {
    const elsewhere: SourcePosting[] = [
      {
        id: "1",
        title: "Dealer",
        location: "Reno, NV, United States",
        applyLink: postingUrl(config, "1"),
        postedAt: "2026-09-01",
      },
    ];

    expect(selectLocal(elsewhere, config)).toEqual([]);
  });
});

describe("createOracleAdapter", () => {
  it("builds the apply link from the config the adapter was created with", () => {
    const raleys = createOracleAdapter({
      ...config,
      host: "fa-epss-saasfaprod1.fa.ocs.oraclecloud.com",
    });

    expect(raleys.parseListing(listing).entries[0].applyLink).toBe(
      "https://fa-epss-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/87812/",
    );
  });
});
