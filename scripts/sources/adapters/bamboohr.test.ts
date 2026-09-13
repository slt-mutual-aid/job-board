import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import {
  parseListing,
  parseDetail,
  selectLocal,
  listingUrl,
  detailUrl,
  BambooHrResponseError,
  type BambooHrConfig,
  type BambooHrListingEntry,
} from "./bamboohr";

const config: BambooHrConfig = {
  subdomain: "vra",
  city: "South Lake Tahoe",
};

function fixture(name: string): string {
  return readFileSync(
    new URL(`../__fixtures__/bamboohr-vra/${name}`, import.meta.url),
    "utf-8",
  );
}

const listing = fixture("listing.json");
const detail = fixture("detail-32.json");

function entryFor(id: string): BambooHrListingEntry {
  const entry = parseListing(listing).entries.find(
    (candidate) => candidate.id === id,
  );
  if (entry === undefined) {
    throw new Error(`The recorded listing carries no posting ${id}`);
  }
  return entry;
}

function withOpening(
  change: (opening: Record<string, unknown>) => void,
): string {
  const decoded = JSON.parse(detail) as {
    result: { jobOpening: Record<string, unknown> };
  };
  change(decoded.result.jobOpening);
  return JSON.stringify(decoded);
}

describe("listingUrl and detailUrl", () => {
  it("build the careers paths for the configured subdomain", () => {
    expect(listingUrl(config)).toBe("https://vra.bamboohr.com/careers/list");
    expect(detailUrl(config, "32")).toBe(
      "https://vra.bamboohr.com/careers/32/detail",
    );
  });
});

describe("parseListing", () => {
  it("maps every entry in the recorded listing", () => {
    const { entries, confirmedEmpty } = parseListing(listing);

    expect(confirmedEmpty).toBe(false);
    expect(entries).toHaveLength(5);
    expect(entries[2]).toEqual({
      id: "32",
      title: "Housekeeping supervisor / manager, vacation rental properties",
      department: "Cleaning",
      commitment: "Full-Time",
      city: "South Lake Tahoe",
      state: "California",
    });
  });

  it("confirms emptiness only when the response reports a total of zero", () => {
    expect(parseListing('{"meta":{"totalCount":0},"result":[]}')).toEqual({
      entries: [],
      confirmedEmpty: true,
    });
  });

  it("withholds confirmation when the total disagrees with the entries", () => {
    expect(
      parseListing('{"meta":{"totalCount":5},"result":[]}').confirmedEmpty,
    ).toBe(false);
  });

  it("throws on a truncated response", () => {
    expect(() => parseListing(listing.slice(0, 900))).toThrow(
      BambooHrResponseError,
    );
  });

  it("throws when the result container is renamed", () => {
    const decoded = JSON.parse(listing) as Record<string, unknown>;
    decoded.jobs = decoded.result;
    delete decoded.result;

    expect(() => parseListing(JSON.stringify(decoded))).toThrow(
      /no "result" array/,
    );
  });

  it("throws when meta.totalCount is absent", () => {
    const decoded = JSON.parse(listing) as Record<string, unknown>;
    decoded.meta = {};

    expect(() => parseListing(JSON.stringify(decoded))).toThrow(
      /no number "meta.totalCount"/,
    );
  });

  it("throws when the root is an array rather than a listing object", () => {
    expect(() => parseListing("[]")).toThrow(/expected a listing object/);
  });

  it("throws when the root is not an object at all", () => {
    expect(() => parseListing('"maintenance"')).toThrow(
      /expected a listing object/,
    );
  });

  it("throws when an entry is missing a required field", () => {
    const decoded = JSON.parse(listing) as {
      result: Array<Record<string, unknown>>;
    };
    delete decoded.result[0].jobOpeningName;

    expect(() => parseListing(JSON.stringify(decoded))).toThrow(
      /Posting at index 0 has no string "jobOpeningName"/,
    );
  });

  it("throws when an entry carries no location object", () => {
    const decoded = JSON.parse(listing) as {
      result: Array<Record<string, unknown>>;
    };
    delete decoded.result[1].location;

    expect(() => parseListing(JSON.stringify(decoded))).toThrow(
      /"location" object at result index 1/,
    );
  });

  it("names the error so a broken endpoint never reads as an empty day", () => {
    let caught: unknown;
    try {
      parseListing("<html>maintenance</html>");
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).name).toBe("BambooHrResponseError");
  });
});

describe("selectLocal", () => {
  it("keeps South Lake Tahoe and drops the far-north postings", () => {
    const { entries } = parseListing(listing);

    const kept = selectLocal(entries, config);

    expect(kept.map((entry) => entry.id)).toEqual(["32", "34", "35"]);
    expect(
      entries
        .filter((entry) => !kept.includes(entry))
        .map((entry) => entry.city),
    ).toEqual(["Truckee", "Truckee"]);
  });
});

describe("parseDetail", () => {
  const entry = entryFor("32");

  it("merges the listing entry with the recorded detail response", () => {
    const posting = parseDetail(detail, entry);

    expect(posting).toMatchObject({
      id: "32",
      title: "Housekeeping supervisor / manager, vacation rental properties",
      department: "Cleaning",
      location: "South Lake Tahoe, California",
      applyLink: "https://vra.bamboohr.com/careers/32",
      postedDate: "5/28/2025",
      commitment: "Full-Time",
      status: "Open",
      isOpen: true,
    });
  });

  it("reduces the description to plain text", () => {
    const { description } = parseDetail(detail, entry);

    expect(description).not.toMatch(/[<>]/);
    expect(description).not.toContain("font-family");
    expect(description).toContain("Greetings, Lake Tahoe!");
  });

  it("reports a status other than Open as closed", () => {
    const closed = withOpening((opening) => {
      opening.jobOpeningStatus = "Filled";
    });
    const posting = parseDetail(closed, entry);

    expect(posting.status).toBe("Filled");
    expect(posting.isOpen).toBe(false);
    expect(posting.title).toBe(entry.title);
  });

  it("throws on a truncated response", () => {
    expect(() => parseDetail(detail.slice(0, 900), entry)).toThrow(
      BambooHrResponseError,
    );
  });

  it("throws when the jobOpening container is renamed", () => {
    const decoded = JSON.parse(detail) as {
      result: Record<string, unknown>;
    };
    decoded.result.opening = decoded.result.jobOpening;
    delete decoded.result.jobOpening;

    expect(() => parseDetail(JSON.stringify(decoded), entry)).toThrow(
      /no "result.jobOpening" object/,
    );
  });

  it("throws when the root is not an object", () => {
    expect(() => parseDetail("[]", entry)).toThrow(/no "result" object/);
  });

  it("throws when the status field is absent", () => {
    const statusless = withOpening((opening) => {
      delete opening.jobOpeningStatus;
    });

    expect(() => parseDetail(statusless, entry)).toThrow(
      /Posting 32 has no string "jobOpeningStatus"/,
    );
  });

  it("throws when the description is absent", () => {
    const descriptionless = withOpening((opening) => {
      delete opening.description;
    });

    expect(() => parseDetail(descriptionless, entry)).toThrow(
      /Posting 32 has no string "description"/,
    );
  });
});
