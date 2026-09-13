import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import {
  parseListing,
  selectLocal,
  listingUrl,
  LeverResponseError,
  type LeverConfig,
} from "./lever";

const config: LeverConfig = {
  company: "insomniacookies",
  location: "South Lake Tahoe CA",
};

function fixture(name: string): string {
  return readFileSync(
    new URL(`../__fixtures__/lever-insomnia/${name}`, import.meta.url),
    "utf-8",
  );
}

const listing = fixture("listing.json");
const empty = fixture("empty.json");

describe("listingUrl", () => {
  it("percent-encodes the location filter", () => {
    expect(listingUrl(config)).toBe(
      "https://api.lever.co/v0/postings/insomniacookies?mode=json&location=South%20Lake%20Tahoe%20CA",
    );
  });
});

describe("parseListing", () => {
  it("maps every posting in the recorded listing", () => {
    const { entries, confirmedEmpty } = parseListing(listing);

    expect(confirmedEmpty).toBe(false);
    expect(entries.map((entry) => entry.title)).toEqual([
      "Cookie Crew",
      "Cookie Delivery Driver",
      "Shift Leader",
    ]);
    expect(entries[0]).toMatchObject({
      id: "f510e61f-8cbf-462a-85e1-3269741808cb",
      location: "South Lake Tahoe CA",
      applyLink:
        "https://jobs.lever.co/insomniacookies/f510e61f-8cbf-462a-85e1-3269741808cb",
      commitment: "Part Time",
      postedAt: "2026-08-16",
    });
    expect(entries[0].description).toContain("Insomnia Cookies");
  });

  it("leaves liveness absent because Lever reports no such signal", () => {
    for (const entry of parseListing(listing).entries) {
      expect(entry.liveness).toBeUndefined();
    }
  });

  it("reads createdAt as a UTC date regardless of the local time zone", () => {
    const beforeUtcMidnight = JSON.stringify([
      {
        id: "a",
        text: "Night Baker",
        hostedUrl: "https://jobs.lever.co/insomniacookies/a",
        categories: { location: config.location },
        createdAt: Date.UTC(2026, 0, 2, 1, 0, 0),
      },
    ]);

    expect(parseListing(beforeUtcMidnight).entries[0].postedAt).toBe(
      "2026-01-02",
    );
  });

  it("omits the optional fields the response does not carry", () => {
    const sparse = JSON.stringify([
      {
        id: "a",
        text: "Night Baker",
        hostedUrl: "https://jobs.lever.co/insomniacookies/a",
        categories: { location: config.location },
        createdAt: Date.UTC(2026, 0, 2, 1, 0, 0),
      },
    ]);

    expect(parseListing(sparse).entries[0]).toEqual({
      id: "a",
      title: "Night Baker",
      location: config.location,
      applyLink: "https://jobs.lever.co/insomniacookies/a",
      postedAt: "2026-01-02",
      commitment: undefined,
      description: undefined,
    });
  });

  it("throws when createdAt is missing", () => {
    const undated = JSON.stringify([
      {
        id: "a",
        text: "Night Baker",
        hostedUrl: "https://jobs.lever.co/insomniacookies/a",
        categories: { location: config.location },
      },
    ]);

    expect(() => parseListing(undated)).toThrow(LeverResponseError);
    expect(() => parseListing(undated)).toThrow(/no number "createdAt"/);
  });

  it("throws when createdAt is not a number", () => {
    const stringDated = JSON.stringify([
      {
        id: "a",
        text: "Night Baker",
        hostedUrl: "https://jobs.lever.co/insomniacookies/a",
        categories: { location: config.location },
        createdAt: "2026-01-02",
      },
    ]);

    expect(() => parseListing(stringDated)).toThrow(LeverResponseError);
    expect(() => parseListing(stringDated)).toThrow(/no number "createdAt"/);
  });

  it("confirms emptiness for a well-formed empty array", () => {
    expect(parseListing(empty)).toEqual({
      entries: [],
      confirmedEmpty: true,
    });
  });

  it("throws on a truncated response", () => {
    expect(() => parseListing(listing.slice(0, 5000))).toThrow(
      LeverResponseError,
    );
  });

  it("throws when the title field is renamed", () => {
    const decoded = JSON.parse(listing) as Array<Record<string, unknown>>;
    for (const posting of decoded) {
      posting.title = posting.text;
      delete posting.text;
    }

    expect(() => parseListing(JSON.stringify(decoded))).toThrow(
      /no string "text"/,
    );
  });

  it("throws when the response is an object rather than an array", () => {
    expect(() => parseListing('{"postings": []}')).toThrow(LeverResponseError);
  });

  it("names the error so a broken endpoint never reads as an empty day", () => {
    let caught: unknown;
    try {
      parseListing("<html>maintenance</html>");
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).name).toBe("LeverResponseError");
  });
});

describe("selectLocal", () => {
  it("drops a posting whose location no longer matches the filter", () => {
    const decoded = JSON.parse(listing) as Array<{
      categories: { location: string };
    }>;
    decoded[1].categories.location = "Reno NV";

    const { entries } = parseListing(JSON.stringify(decoded));

    expect(selectLocal(entries, config).map((entry) => entry.title)).toEqual([
      "Cookie Crew",
      "Shift Leader",
    ]);
  });
});
