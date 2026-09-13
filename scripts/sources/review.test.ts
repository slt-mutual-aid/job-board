import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import { observedFailure, type SourceObservation } from "./health";
import {
  icimsOvgSource,
  leverSource,
  oracleCaesarsSource,
  sources,
} from "./registry";
import {
  BOARD_COLUMN_COUNT,
  DECISION_HEADER,
  FIT_HEADER,
  FIT_REASON_HEADER,
  POSTING_KEY_HEADER,
  REVIEW_COLUMN_HEADERS,
  REVIEW_CSV_PATH,
  SOURCE_HEADER,
} from "./review-csv";
import {
  readerFor,
  readers,
  runReview,
  toReviewJob,
  type ReviewReader,
  type ReviewSource,
} from "./review";
import { toSpreadsheetDate } from "./date";
import { FIT_ORDER, type FitVerdict } from "./fit";
import { postingKey } from "./state";
import {
  SourceResponseError,
  type ListingOnlyAdapter,
  type ListingThenDetailAdapter,
  type SourcePosting,
} from "./types";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// An injected clock keeps every assertion independent of when the suite runs.
function at(day: number): Date {
  return new Date(Date.UTC(2026, 0, 1) + day * MILLISECONDS_PER_DAY);
}

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), {
    encoding: "utf-8",
  });
}

// Every posting in these tests comes out of a recorded listing, so no
// assertion depends on a request leaving the machine.
function localPostings<Config>(
  source: { adapter: ListingOnlyAdapter<Config>; config: Config },
  raw: string,
): SourcePosting[] {
  const { entries } = source.adapter.parseListing(raw);
  return source.adapter.selectLocal(entries, source.config);
}

const leverPostings = localPostings(
  leverSource,
  fixture("lever-insomnia/listing.json"),
);
const icimsPostings = localPostings(
  icimsOvgSource,
  fixture("icims-ovg/listing.html.txt"),
);
const oraclePostings = localPostings(
  oracleCaesarsSource,
  fixture("oracle-caesars/listing.json"),
);

function reading(
  sourceId: string,
  postings: readonly SourcePosting[],
): SourceObservation<SourcePosting> {
  return {
    kind: "reading",
    sourceId,
    postings,
    entryCount: postings.length,
    confirmedEmpty: postings.length === 0,
  };
}

function failure(sourceId: string): SourceObservation<SourcePosting> {
  return observedFailure(sourceId, new SourceResponseError("no listing block"));
}

// The three sources the run reads, standing in for the seven the registry
// carries. Each answers with whatever the test last put in the plan.
const STUBBED: ReviewSource[] = [
  leverSource,
  icimsOvgSource,
  oracleCaesarsSource,
];

type Plan = Map<string, SourceObservation<SourcePosting>>;

function healthyPlan(): Plan {
  return new Map([
    [leverSource.sourceId, reading(leverSource.sourceId, leverPostings)],
    [icimsOvgSource.sourceId, reading(icimsOvgSource.sourceId, icimsPostings)],
    [
      oracleCaesarsSource.sourceId,
      reading(oracleCaesarsSource.sourceId, oraclePostings),
    ],
  ]);
}

function readersFor(plan: Plan): ReviewReader[] {
  return STUBBED.map((source) => ({
    sourceId: source.sourceId,
    accountId: source.accountId,
    companyName: source.companyName,
    read: async () => plan.get(source.sourceId) ?? reading(source.sourceId, []),
  }));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sources-review-"));
  // runReview names each source as it reads it, which is progress for a person
  // and noise in a suite.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function reviewText(): string {
  return readFileSync(join(root, REVIEW_CSV_PATH), "utf-8");
}

function reviewRows(): string[][] {
  const records = parseCsv(reviewText(), {
    record_delimiter: ["\r\n", "\n", "\r"],
  }) as string[][];
  return records.slice(1);
}

function columnOf(header: string): number {
  return REVIEW_COLUMN_HEADERS.indexOf(header);
}

function cellsIn(header: string): string[] {
  return reviewRows().map((row) => row[columnOf(header)]);
}

// The reviewer typing a decision into the spreadsheet, which is the only event
// that takes a posting out of the queue.
function recordDecision(key: string, decision: string): void {
  const target = join(root, REVIEW_CSV_PATH);
  const records = parseCsv(readFileSync(target, "utf-8"), {
    record_delimiter: ["\r\n", "\n", "\r"],
  }) as string[][];

  for (const row of records.slice(1)) {
    if (row[columnOf(POSTING_KEY_HEADER)] === key) {
      row[columnOf(DECISION_HEADER)] = decision;
    }
  }

  writeFileSync(
    target,
    stringifyCsv(records, {
      record_delimiter: "\r\n",
      quoted_match: /[\r\n]/,
    }),
    "utf-8",
  );
}

describe("the review file across every source", () => {
  it("carries the rows of every source in one file", async () => {
    expect(leverPostings.length).toBeGreaterThan(0);
    expect(icimsPostings.length).toBeGreaterThan(0);
    expect(oraclePostings.length).toBeGreaterThan(0);

    await runReview(readersFor(healthyPlan()), at(0), root);

    expect(reviewRows()).toHaveLength(
      leverPostings.length + icimsPostings.length + oraclePostings.length,
    );
  });

  it("names the employer and the listing each row came from", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);

    expect(new Set(cellsIn(SOURCE_HEADER))).toEqual(
      new Set(STUBBED.map((source) => source.sourceId)),
    );
    expect(new Set(cellsIn("Company"))).toEqual(
      new Set(STUBBED.map((source) => source.companyName)),
    );
  });

  it("opens every row with the nine board columns the importer reads", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);

    const [header] = parseCsv(reviewText(), {
      record_delimiter: ["\r\n", "\n", "\r"],
    }) as string[][];
    expect(header.slice(0, BOARD_COLUMN_COUNT)).toEqual(
      REVIEW_COLUMN_HEADERS.slice(0, BOARD_COLUMN_COUNT),
    );

    const [row] = reviewRows();
    expect(row).toHaveLength(REVIEW_COLUMN_HEADERS.length);
  });

  it("leaves the file untouched by a second run that finds nothing new", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);
    const first = reviewText();

    await runReview(readersFor(healthyPlan()), at(1), root);

    expect(reviewText()).toBe(first);
  });

  it("drops the posting the reviewer decided, and only that posting", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);
    const decided = postingKey(icimsOvgSource.accountId, icimsPostings[0].id);
    recordDecision(decided, "Approved");

    await runReview(readersFor(healthyPlan()), at(1), root);

    const keys = cellsIn(POSTING_KEY_HEADER);
    expect(keys).not.toContain(decided);
    expect(keys).toHaveLength(
      leverPostings.length + icimsPostings.length + oraclePostings.length - 1,
    );
  });

  it("never offers a decided posting again, once the file has dropped it", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);
    const decided = postingKey(leverSource.accountId, leverPostings[0].id);
    recordDecision(decided, "Declined");
    await runReview(readersFor(healthyPlan()), at(1), root);

    // The decision now lives only in the state file, because the run above
    // rewrote the review file without the row carrying it.
    await runReview(readersFor(healthyPlan()), at(2), root);

    expect(cellsIn(POSTING_KEY_HEADER)).not.toContain(decided);
  });
});

describe("two sources handing out one identifier", () => {
  function postingNamed(id: string, title: string): SourcePosting {
    return {
      id,
      title,
      location: "South Lake Tahoe",
      applyLink: `https://example.test/${id}`,
      postedAt: "2026-01-01",
    };
  }

  const shared = "42";

  function plan(): Plan {
    return new Map([
      [
        leverSource.sourceId,
        reading(leverSource.sourceId, [postingNamed(shared, "Cookie Crew")]),
      ],
      [
        icimsOvgSource.sourceId,
        reading(icimsOvgSource.sourceId, [
          postingNamed(shared, "Box Office Ticket Seller"),
        ]),
      ],
      [oracleCaesarsSource.sourceId, reading(oracleCaesarsSource.sourceId, [])],
    ]);
  }

  it("reads a decision back against the one source that earned it", async () => {
    await runReview(readersFor(plan()), at(0), root);
    expect(reviewRows()).toHaveLength(2);

    recordDecision(postingKey(leverSource.accountId, shared), "Approved");
    await runReview(readersFor(plan()), at(1), root);

    expect(cellsIn(POSTING_KEY_HEADER)).toEqual([
      postingKey(icimsOvgSource.accountId, shared),
    ]);
  });
});

describe("a source that fails part way through a run", () => {
  it("keeps the rows an earlier run wrote for it", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);
    const before = reviewRows().filter(
      (row) => row[columnOf(SOURCE_HEADER)] === icimsOvgSource.sourceId,
    );
    expect(before.length).toBeGreaterThan(0);

    const broken = healthyPlan();
    broken.set(icimsOvgSource.sourceId, failure(icimsOvgSource.sourceId));
    await runReview(readersFor(broken), at(1), root);

    const after = reviewRows().filter(
      (row) => row[columnOf(SOURCE_HEADER)] === icimsOvgSource.sourceId,
    );
    expect(after).toEqual(before);
  });

  it("still writes the postings of every source that answered", async () => {
    const extra: SourcePosting = {
      id: "new-requisition",
      title: "Line Cook",
      location: "South Lake Tahoe, NV, United States",
      applyLink: "https://example.test/new-requisition",
      postedAt: "2026-01-02",
    };

    await runReview(readersFor(healthyPlan()), at(0), root);

    const broken = healthyPlan();
    broken.set(leverSource.sourceId, failure(leverSource.sourceId));
    broken.set(
      oracleCaesarsSource.sourceId,
      reading(oracleCaesarsSource.sourceId, [...oraclePostings, extra]),
    );
    await runReview(readersFor(broken), at(1), root);

    expect(cellsIn(POSTING_KEY_HEADER)).toContain(
      postingKey(oracleCaesarsSource.accountId, extra.id),
    );
    expect(reviewRows()).toHaveLength(
      leverPostings.length + icimsPostings.length + oraclePostings.length + 1,
    );
  });

  it("reports the failure rather than counting the employer as empty", async () => {
    const broken = healthyPlan();
    broken.set(icimsOvgSource.sourceId, failure(icimsOvgSource.sourceId));

    const { counts, assessments } = await runReview(
      readersFor(broken),
      at(0),
      root,
    );

    const count = counts.find(
      (entry) => entry.sourceId === icimsOvgSource.sourceId,
    );
    expect(count).toEqual({
      sourceId: icimsOvgSource.sourceId,
      status: "error",
      rowCount: 0,
      carriedForward: true,
    });
    expect(
      assessments.find((entry) => entry.sourceId === icimsOvgSource.sourceId)
        ?.postingCount,
    ).toBeNull();
  });

  it("contributes nothing when it fails before any run wrote its rows", async () => {
    const broken = healthyPlan();
    broken.set(icimsOvgSource.sourceId, failure(icimsOvgSource.sourceId));

    await runReview(readersFor(broken), at(0), root);

    expect(cellsIn(SOURCE_HEADER)).not.toContain(icimsOvgSource.sourceId);
    expect(reviewRows()).toHaveLength(
      leverPostings.length + oraclePostings.length,
    );
  });

  it("does not bring back a row the reviewer already decided", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);
    const decided = postingKey(icimsOvgSource.accountId, icimsPostings[0].id);
    recordDecision(decided, "Declined");

    const broken = healthyPlan();
    broken.set(icimsOvgSource.sourceId, failure(icimsOvgSource.sourceId));
    await runReview(readersFor(broken), at(1), root);

    expect(cellsIn(POSTING_KEY_HEADER)).not.toContain(decided);
  });
});

describe("review coverage", () => {
  it("reads every source in the registry", () => {
    // A source the review run never reads is a source whose openings reach
    // nobody, while the file still reads as the whole town's.
    expect(readers.map((reader) => reader.sourceId).sort()).toEqual(
      sources.map((source) => source.sourceId).sort(),
    );
  });

  it("gives every source the employer name the Company column needs", () => {
    for (const source of sources) {
      expect(source.companyName).not.toBe("");
    }
  });
});

describe("a source whose listing does not carry a whole posting", () => {
  // The recorded BambooHR pair, served by an adapter that reads no network.
  const listing = fixture("bamboohr-vra/listing.json");
  const detail = fixture("bamboohr-vra/detail-32.json");

  interface Entry {
    id: string;
  }

  const adapter: ListingThenDetailAdapter<Record<string, never>, Entry> = {
    id: "recorded",
    shape: "listing-then-detail",
    listingUrl: () => "https://example.test/list",
    fetchListingRaw: async () => listing,
    parseListing: () => ({ entries: [{ id: "32" }], confirmedEmpty: false }),
    selectLocal: (entries) => entries,
    detailUrl: () => "https://example.test/32",
    fetchDetailRaw: async () => detail,
    parseDetail: (raw) => {
      const opening = (
        JSON.parse(raw) as {
          result: {
            jobOpening: {
              jobOpeningName: string;
              jobOpeningShareUrl: string;
              description: string;
            };
          };
        }
      ).result.jobOpening;
      return {
        id: "32",
        title: opening.jobOpeningName,
        location: "South Lake Tahoe",
        applyLink: opening.jobOpeningShareUrl,
        postedAt: "2026-01-01",
        description: opening.description,
      };
    },
  };

  const source: ReviewSource = {
    sourceId: "recorded",
    accountId: "recorded:vra",
    companyName: "VRA",
  };

  it("completes each selected entry before the posting reaches a row", async () => {
    const observation = await readerFor({
      ...source,
      adapter,
      config: {},
    }).read();

    expect(observation.kind).toBe("reading");
    if (observation.kind !== "reading") {
      return;
    }

    const [posting] = observation.postings;
    expect(posting.title).toContain("Housekeeping");

    const job = toReviewJob(source, posting);
    expect(job.description).toContain("Greetings, Lake Tahoe!");
    // The detail response publishes the description as markup, and a
    // spreadsheet cell is read by a person.
    expect(job.description).not.toContain("<p>");
  });
});
describe("the order the review file puts its rows in", () => {
  const RECORDED_ROW_COUNT =
    leverPostings.length + icimsPostings.length + oraclePostings.length;

  function rowFor(key: string): string[] {
    const row = reviewRows().find(
      (candidate) => candidate[columnOf(POSTING_KEY_HEADER)] === key,
    );
    if (row === undefined) {
      throw new Error(`The review file carries no row for ${key}`);
    }
    return row;
  }

  it("puts every likely posting first and every unlikely posting last", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);

    const verdicts = cellsIn(FIT_HEADER);
    // All three groups have to be on the file for the order to prove anything.
    expect(new Set(verdicts)).toEqual(new Set(FIT_ORDER));

    const ranks = verdicts.map((verdict) =>
      FIT_ORDER.indexOf(verdict as FitVerdict),
    );
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  it("carries every posting the sources returned, unlikely ones included", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);

    expect(reviewRows()).toHaveLength(RECORDED_ROW_COUNT);
    expect(
      cellsIn(FIT_HEADER).filter((verdict) => verdict === "unlikely").length,
    ).toBeGreaterThan(0);
  });

  it("keeps one employer's rows together inside a group", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);

    const unknown = reviewRows().filter(
      (row) => row[columnOf(FIT_HEADER)] === "unknown",
    );
    const employers = unknown.map((row) => row[columnOf(SOURCE_HEADER)]);
    const runs = employers.filter(
      (employer, index) => employer !== employers[index - 1],
    );
    expect(runs).toEqual([...new Set(employers)]);
  });

  it("leaves the nine board columns as the source published them", async () => {
    await runReview(readersFor(healthyPlan()), at(0), root);

    const posting = oraclePostings[0];
    const row = rowFor(postingKey(oracleCaesarsSource.accountId, posting.id));

    expect(row[columnOf(FIT_HEADER)]).not.toBe("");
    expect(row.slice(0, BOARD_COLUMN_COUNT)).toEqual([
      toSpreadsheetDate(posting.postedAt),
      oracleCaesarsSource.companyName,
      posting.title,
      posting.applyLink,
      "",
      "",
      posting.location,
      "",
      "",
    ]);
  });

  it("says a posting is unknown where its source publishes no employment type", async () => {
    const posting = oraclePostings.find(
      (candidate) =>
        candidate.commitment === undefined &&
        candidate.description === undefined,
    );
    expect(posting).toBeDefined();

    await runReview(readersFor(healthyPlan()), at(0), root);

    const row = rowFor(
      postingKey(oracleCaesarsSource.accountId, posting?.id ?? ""),
    );
    expect(row[columnOf(FIT_HEADER)]).toBe("unknown");
    expect(row[columnOf(FIT_REASON_HEADER)]).toContain("no employment type");
  });
});
