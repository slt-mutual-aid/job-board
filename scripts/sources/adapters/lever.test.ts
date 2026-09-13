import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { parse, buildUrl, LeverResponseError, type LeverConfig } from "./lever";

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

describe("buildUrl", () => {
  it("percent-encodes the location filter", () => {
    expect(buildUrl(config)).toBe(
      "https://api.lever.co/v0/postings/insomniacookies?mode=json&location=South%20Lake%20Tahoe%20CA",
    );
  });
});

describe("parse", () => {
  it("maps every posting in the recorded listing", () => {
    const { postings, confirmedEmpty } = parse(listing, config);

    expect(confirmedEmpty).toBe(false);
    expect(postings.map((posting) => posting.title)).toEqual([
      "Cookie Crew",
      "Cookie Delivery Driver",
      "Shift Leader",
    ]);
    expect(postings[0]).toMatchObject({
      id: "f510e61f-8cbf-462a-85e1-3269741808cb",
      location: "South Lake Tahoe CA",
      applyLink:
        "https://jobs.lever.co/insomniacookies/f510e61f-8cbf-462a-85e1-3269741808cb",
      commitment: "Part Time",
      postedDate: "2026-08-16",
    });
    expect(postings[0].description).toContain("Insomnia Cookies");
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

    expect(parse(beforeUtcMidnight, config).postings[0].postedDate).toBe(
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

    expect(parse(sparse, config).postings[0]).toEqual({
      id: "a",
      title: "Night Baker",
      location: config.location,
      applyLink: "https://jobs.lever.co/insomniacookies/a",
      postedDate: "2026-01-02",
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

    expect(() => parse(undated, config)).toThrow(LeverResponseError);
    expect(() => parse(undated, config)).toThrow(/no number "createdAt"/);
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

    expect(() => parse(stringDated, config)).toThrow(LeverResponseError);
    expect(() => parse(stringDated, config)).toThrow(/no number "createdAt"/);
  });

  it("confirms emptiness for a well-formed empty array", () => {
    expect(parse(empty, config)).toEqual({
      postings: [],
      confirmedEmpty: true,
    });
  });

  it("drops a posting whose location no longer matches the filter", () => {
    const decoded = JSON.parse(listing) as Array<{
      categories: { location: string };
    }>;
    decoded[1].categories.location = "Reno NV";

    const { postings, confirmedEmpty } = parse(JSON.stringify(decoded), config);

    expect(postings.map((posting) => posting.title)).toEqual([
      "Cookie Crew",
      "Shift Leader",
    ]);
    expect(confirmedEmpty).toBe(false);
  });

  it("throws on a truncated response", () => {
    expect(() => parse(listing.slice(0, 5000), config)).toThrow(
      LeverResponseError,
    );
  });

  it("throws when the title field is renamed", () => {
    const decoded = JSON.parse(listing) as Array<Record<string, unknown>>;
    for (const posting of decoded) {
      posting.title = posting.text;
      delete posting.text;
    }

    expect(() => parse(JSON.stringify(decoded), config)).toThrow(
      /no string "text"/,
    );
  });

  it("throws when the response is an object rather than an array", () => {
    expect(() => parse('{"postings": []}', config)).toThrow(LeverResponseError);
  });

  it("names the error so a broken endpoint never reads as an empty day", () => {
    let caught: unknown;
    try {
      parse("<html>maintenance</html>", config);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).name).toBe("LeverResponseError");
  });
});
