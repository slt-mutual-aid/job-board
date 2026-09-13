import { readFileSync } from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetRunState } from "../http";
import { readers } from "../health-cli";
import { ukgSource } from "../registry";
import { SourceResponseError, type SourcePosting } from "../types";
import {
  MAX_PAGES,
  PAGE_SIZE,
  fetchListingRaw,
  parseListing,
  selectLocal,
  toPagedListing,
} from "./ukg";

const { config } = ukgSource;

// Recorded from the live endpoint; see the .meta.json beside each file for the
// request and the time of the fetch.
function fixture(name: string): string {
  return readFileSync(
    new URL(`../__fixtures__/ukg-ballys/${name}`, import.meta.url),
    "utf-8",
  );
}

const RECORDED_PAGES = [0, 1, 2].map((index) => fixture(`page-${index}.json`));
const RECORDED_EMPTY = fixture("empty.json");

const ROBOTS = readFileSync(
  new URL("../__fixtures__/robots/recruiting.ultipro.com.txt", import.meta.url),
  "utf-8",
);

interface RecordedPage {
  opportunities: Array<Record<string, unknown>>;
  totalCount: number;
}

function decodePage(raw: string): RecordedPage {
  return JSON.parse(raw) as RecordedPage;
}

function read(pages: readonly string[]): SourcePosting[] {
  return selectLocal(
    parseListing(toPagedListing(config, pages)).entries,
    config,
  );
}

function recordedTotal(): number {
  return decodePage(RECORDED_PAGES[0]).totalCount;
}

// One opportunity lifted from the recording, so a synthetic page carries the
// shape the endpoint actually returns rather than the shape the parser wants.
function template(): Record<string, unknown> {
  return decodePage(RECORDED_PAGES[0]).opportunities[0];
}

function syntheticPage(total: number, skip: number): string {
  const size = Math.min(PAGE_SIZE, Math.max(0, total - skip));
  const opportunities = Array.from({ length: size }, (_, index) => ({
    ...template(),
    Id: `synthetic-${skip + index}`,
  }));
  return JSON.stringify({ opportunities, totalCount: total, locations: [] });
}

describe("reading the recorded pages", () => {
  it("takes every Stateline posting and leaves the rest of the company", () => {
    const postings = read(RECORDED_PAGES);
    const entries = parseListing(
      toPagedListing(config, RECORDED_PAGES),
    ).entries;

    expect(entries.length).toBe(PAGE_SIZE * RECORDED_PAGES.length);
    expect(postings.length).toBe(33);
    for (const posting of postings) {
      expect(posting.location).toContain("Stateline, NV");
    }
  });

  it("builds the public posting page from the board the pages came from", () => {
    const [posting] = read(RECORDED_PAGES);

    expect(posting.applyLink).toBe(
      `https://recruiting.ultipro.com/${config.tenant}/JobBoard/${config.jobBoardId}/OpportunityDetail?opportunityId=${posting.id}`,
    );
  });

  it("names a commitment only where the source calls the posting full time", () => {
    const postings = read(RECORDED_PAGES);
    const byTitle = new Map(
      postings.map((posting) => [posting.title, posting.commitment]),
    );

    expect(byTitle.get("Facilities Tech I (Full Time)")).toBe("Full Time");
    expect(byTitle.get("Spa Attendant (On-Call)")).toBeUndefined();
  });

  it("keeps a posting whose first location is another city", () => {
    const decoded = decodePage(RECORDED_PAGES[0]);
    const elsewhere = {
      Address: { City: "Chicago", State: { Code: "IL", Name: "Illinois" } },
    };
    const [stateline] = decoded.opportunities.filter(
      (opportunity) =>
        (opportunity.Locations as Array<{ Address: { City: string } }>)[0]
          .Address.City === "Stateline",
    );
    stateline.Locations = [elsewhere, ...(stateline.Locations as unknown[])];

    const postings = read([
      JSON.stringify(decoded),
      ...RECORDED_PAGES.slice(1),
    ]);
    const moved = postings.find((posting) => posting.id === stateline.Id);

    expect(moved?.location).toBe("Chicago, IL; Stateline, NV");
  });

  it("reports the recorded empty response as empty", () => {
    const listing = parseListing(toPagedListing(config, [RECORDED_EMPTY]));

    expect(listing.entries).toEqual([]);
    expect(listing.confirmedEmpty).toBe(true);
  });
});

describe("the total the endpoint reports about itself", () => {
  it("throws when a page comes back shorter than the total makes it", () => {
    const decoded = decodePage(RECORDED_PAGES[1]);
    decoded.opportunities = decoded.opportunities.slice(0, 20);
    const pages = [RECORDED_PAGES[0], JSON.stringify(decoded)];

    expect(() => read(pages)).toThrow(SourceResponseError);
    expect(() => read(pages)).toThrow(/carries 20 opportunities/);
  });

  it("throws when a later page reports a different total", () => {
    const decoded = decodePage(RECORDED_PAGES[1]);
    decoded.totalCount = recordedTotal() + 1;

    expect(() => read([RECORDED_PAGES[0], JSON.stringify(decoded)])).toThrow(
      /reports a total of/,
    );
  });

  it("throws when the pages outnumber what the total fills", () => {
    const total = PAGE_SIZE;
    const pages = [
      syntheticPage(total, 0),
      syntheticPage(total + PAGE_SIZE, 0),
    ];

    expect(() => read(pages)).toThrow(SourceResponseError);
  });

  it("throws on a response that is not JSON rather than reading it as empty", () => {
    expect(() => read(["<html>maintenance</html>"])).toThrow(
      SourceResponseError,
    );
  });
});

describe("paging the live endpoint", () => {
  let respond: (skip: number) => Response;
  let skips: number[];

  async function settled<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    return promise;
  }

  beforeEach(() => {
    resetRunState();
    skips = [];
    respond = (skip) => new Response(syntheticPage(recordedTotal(), skip));
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/robots.txt")) {
          return Promise.resolve(new Response(ROBOTS));
        }
        const { opportunitySearch } = JSON.parse(String(init?.body)) as {
          opportunitySearch: { Skip: number };
        };
        skips.push(opportunitySearch.Skip);
        return Promise.resolve(respond(opportunitySearch.Skip));
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("walks one page at a time until the pages cover the total", async () => {
    const raw = await settled(fetchListingRaw(config));

    expect(skips).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400]);
    expect(parseListing(raw).entries.length).toBe(recordedTotal());
  });

  it("throws rather than returning the pages that did arrive", async () => {
    respond = (skip) =>
      skip === 150
        ? new Response("", { status: 503 })
        : new Response(syntheticPage(recordedTotal(), skip));

    await expect(settled(fetchListingRaw(config))).rejects.toThrow(/HTTP 503/);
  });

  it("stops at the page ceiling when the total never comes into reach", async () => {
    const unreachable = PAGE_SIZE * (MAX_PAGES + 5);
    respond = (skip) => new Response(syntheticPage(unreachable, skip));

    await expect(settled(fetchListingRaw(config))).rejects.toThrow(
      /reached 20 pages/,
    );
    expect(skips.length).toBe(MAX_PAGES);
  });

  // A short listing would reach reconciliation as an employer that withdrew the
  // postings on the page nobody read, so the run reports a failure instead, and
  // a failure carries neither a count nor any postings.
  it("reaches the health run as a failure carrying no count", async () => {
    respond = (skip) =>
      skip === 150
        ? new Response("", { status: 503 })
        : new Response(syntheticPage(recordedTotal(), skip));
    const reader = readers.find(
      (candidate) => candidate.id === ukgSource.sourceId,
    );

    const observation = await settled(reader!.read());

    expect(observation.kind).toBe("failure");
    expect(observation).not.toHaveProperty("postings");
  });
});
