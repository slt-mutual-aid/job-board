import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parse as parseCsv } from "csv-parse/sync";
import {
  WriteOutsideAllowlistError,
  writeAllowedFile,
  writeReviewCsv,
} from "./review-csv";
import { leverSource } from "./registry";
import { SOURCE_ID, toReviewJob } from "./lever-cli";
import {
  PRUNE_AFTER_DAYS,
  RUN_COUNT_HISTORY,
  SOURCES_STATE_PATH,
  emptyState,
  loadSourcesState,
  markReported,
  postingKey,
  pruneSourcesState,
  recordFailedRun,
  recordRun,
  saveSourcesState,
  type SeenPosting,
  type SourcesState,
} from "./state";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// An injected clock keeps every assertion about ageing independent of when the
// suite runs.
function at(day: number): Date {
  return new Date(Date.UTC(2026, 0, 1) + day * MILLISECONDS_PER_DAY);
}

function posting(id: string, title = "Cookie Crew"): SeenPosting {
  return {
    key: postingKey(SOURCE_ID, id),
    title,
    url: `https://jobs.lever.co/insomniacookies/${id}?source=slt`,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sources-state-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRawState(contents: string): void {
  const target = join(root, SOURCES_STATE_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf-8");
}

describe("postingKey", () => {
  it("keeps two sources that hand out the same identifier apart", () => {
    expect(postingKey("lever:insomniacookies", "42")).not.toBe(
      postingKey("bamboohr:vra", "42"),
    );
  });

  it("ignores the tracking parameters an apply link carries", () => {
    const first = posting("abc");
    const second: SeenPosting = {
      ...first,
      url: "https://jobs.lever.co/insomniacookies/abc?source=other",
    };
    expect(second.key).toBe(first.key);
  });
});

describe("recordRun", () => {
  it("reports every posting on the first run", () => {
    const { unreported } = recordRun(
      emptyState(),
      SOURCE_ID,
      [posting("abc"), posting("def")],
      at(0),
    );

    expect(unreported.map((entry) => entry.key)).toEqual([
      postingKey(SOURCE_ID, "abc"),
      postingKey(SOURCE_ID, "def"),
    ]);
  });

  it("reports nothing on a second identical run", () => {
    const postings = [posting("abc"), posting("def")];
    const first = recordRun(emptyState(), SOURCE_ID, postings, at(0));
    const reported = markReported(
      first.state,
      first.unreported.map((entry) => entry.key),
    );

    const second = recordRun(reported, SOURCE_ID, postings, at(1));

    expect(second.unreported).toEqual([]);
  });

  it("holds a posting back until the reviewer has actually been handed it", () => {
    const first = recordRun(emptyState(), SOURCE_ID, [posting("abc")], at(0));

    // The review file was never written, so the posting is still owed to the
    // reviewer on the next run.
    const second = recordRun(first.state, SOURCE_ID, [posting("abc")], at(1));

    expect(second.unreported.map((entry) => entry.key)).toEqual([
      postingKey(SOURCE_ID, "abc"),
    ]);
  });

  it("keeps the first sighting and advances the last sighting", () => {
    const first = recordRun(emptyState(), SOURCE_ID, [posting("abc")], at(0));
    const second = recordRun(first.state, SOURCE_ID, [posting("abc")], at(3));

    const record = second.state.postings[postingKey(SOURCE_ID, "abc")];
    expect(record.firstSeen).toBe(at(0).toISOString());
    expect(record.lastSeen).toBe(at(3).toISOString());
  });

  it("records the title and the url of each posting", () => {
    const { state } = recordRun(
      emptyState(),
      SOURCE_ID,
      [posting("abc", "Shift Lead")],
      at(0),
    );

    const record = state.postings[postingKey(SOURCE_ID, "abc")];
    expect(record.title).toBe("Shift Lead");
    expect(record.url).toBe(
      "https://jobs.lever.co/insomniacookies/abc?source=slt",
    );
  });

  it("does not report a posting again after it disappears and returns", () => {
    const first = recordRun(emptyState(), SOURCE_ID, [posting("abc")], at(0));
    const reported = markReported(
      first.state,
      first.unreported.map((entry) => entry.key),
    );

    const gone = recordRun(reported, SOURCE_ID, [], at(1));
    const back = recordRun(gone.state, SOURCE_ID, [posting("abc")], at(2));

    expect(back.unreported).toEqual([]);
    expect(back.state.postings[postingKey(SOURCE_ID, "abc")].firstSeen).toBe(
      at(0).toISOString(),
    );
  });

  it("dates the run and the successful run of the source", () => {
    const { state } = recordRun(emptyState(), SOURCE_ID, [], at(4));

    expect(state.sources[SOURCE_ID].lastRun).toBe(at(4).toISOString());
    expect(state.sources[SOURCE_ID].lastSuccessfulRun).toBe(
      at(4).toISOString(),
    );
  });

  it("appends the posting count of each run", () => {
    const first = recordRun(emptyState(), SOURCE_ID, [posting("abc")], at(0));
    const second = recordRun(
      first.state,
      SOURCE_ID,
      [posting("abc"), posting("def")],
      at(1),
    );

    expect(second.state.sources[SOURCE_ID].recentCounts).toEqual([1, 2]);
  });

  it("keeps the count history to a fixed length", () => {
    let state = emptyState();
    for (let run = 0; run <= RUN_COUNT_HISTORY + 2; run += 1) {
      state = recordRun(state, SOURCE_ID, [], at(run)).state;
    }

    expect(state.sources[SOURCE_ID].recentCounts).toHaveLength(
      RUN_COUNT_HISTORY,
    );
  });
});

describe("recordFailedRun", () => {
  it("dates the run without moving the successful run", () => {
    const succeeded = recordRun(emptyState(), SOURCE_ID, [], at(0)).state;

    const failed = recordFailedRun(succeeded, SOURCE_ID, at(1));

    expect(failed.sources[SOURCE_ID].lastRun).toBe(at(1).toISOString());
    expect(failed.sources[SOURCE_ID].lastSuccessfulRun).toBe(
      at(0).toISOString(),
    );
  });

  it("adds no count for a run that returned no posting list", () => {
    const succeeded = recordRun(
      emptyState(),
      SOURCE_ID,
      [posting("abc")],
      at(0),
    ).state;

    const failed = recordFailedRun(succeeded, SOURCE_ID, at(1));

    expect(failed.sources[SOURCE_ID].recentCounts).toEqual([1]);
  });

  it("dates the first run of a source that has never succeeded", () => {
    const state = recordFailedRun(emptyState(), SOURCE_ID, at(1));

    expect(state.sources[SOURCE_ID].lastRun).toBe(at(1).toISOString());
    expect(state.sources[SOURCE_ID].lastSuccessfulRun).toBeUndefined();
  });
});

describe("pruneSourcesState", () => {
  it("drops a posting not seen for the whole prune interval", () => {
    const { state } = recordRun(
      emptyState(),
      SOURCE_ID,
      [posting("abc")],
      at(0),
    );

    const pruned = pruneSourcesState(state, at(PRUNE_AFTER_DAYS + 1));

    expect(pruned.postings).toEqual({});
  });

  it("keeps a posting seen inside the prune interval", () => {
    const { state } = recordRun(
      emptyState(),
      SOURCE_ID,
      [posting("abc")],
      at(0),
    );

    const pruned = pruneSourcesState(state, at(PRUNE_AFTER_DAYS - 1));

    expect(Object.keys(pruned.postings)).toEqual([
      postingKey(SOURCE_ID, "abc"),
    ]);
  });

  it("keeps the run history of the source it prunes postings from", () => {
    const { state } = recordRun(
      emptyState(),
      SOURCE_ID,
      [posting("abc")],
      at(0),
    );

    const pruned = pruneSourcesState(state, at(PRUNE_AFTER_DAYS + 1));

    expect(pruned.sources[SOURCE_ID].recentCounts).toEqual([1]);
  });
});

describe("loadSourcesState", () => {
  it("reads back what saveSourcesState wrote", () => {
    const { state } = recordRun(
      emptyState(),
      SOURCE_ID,
      [posting("abc")],
      at(0),
    );
    saveSourcesState(state, root);

    expect(loadSourcesState(root)).toEqual(state);
  });

  it("treats an absent file as a first run", () => {
    expect(loadSourcesState(root)).toEqual(emptyState());
  });

  it("treats a file that is not JSON as a first run", () => {
    writeRawState("{ not json");

    expect(loadSourcesState(root)).toEqual(emptyState());
  });

  it("treats a JSON file of the wrong shape as a first run", () => {
    writeRawState('["abc"]');

    expect(loadSourcesState(root)).toEqual(emptyState());
  });

  it("keeps the sound records of a file carrying one broken posting", () => {
    writeRawState(
      JSON.stringify({
        postings: {
          "lever:insomniacookies:abc": {
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-01T00:00:00.000Z",
            title: "Cookie Crew",
            url: "https://jobs.lever.co/insomniacookies/abc",
            reported: true,
          },
          "lever:insomniacookies:def": { reported: "yes" },
        },
        sources: {},
      }),
    );

    const state = loadSourcesState(root);

    expect(Object.keys(state.postings)).toEqual(["lever:insomniacookies:abc"]);
  });

  it("drops a posting whose timestamp cannot be read as a date", () => {
    writeRawState(
      JSON.stringify({
        postings: {
          "lever:insomniacookies:abc": {
            firstSeen: "whenever",
            lastSeen: "whenever",
            title: "Cookie Crew",
            url: "https://jobs.lever.co/insomniacookies/abc",
            reported: true,
          },
        },
        sources: {},
      }),
    );

    expect(loadSourcesState(root).postings).toEqual({});
  });
});

describe("saveSourcesState", () => {
  it("writes through the allowlist, under scripts/data", () => {
    const target = saveSourcesState(emptyState(), root);

    expect(target).toBe(join(root, SOURCES_STATE_PATH));
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual(emptyState());
  });

  it("names a path the existing allowlist already permits", () => {
    expect(() =>
      writeAllowedFile(SOURCES_STATE_PATH, "{}", root),
    ).not.toThrow();
    // One directory up is outside scripts/data, so the guard the state file
    // passes through is still the guard that refuses everything else.
    expect(() =>
      writeAllowedFile(join("scripts", "sources-state.json"), "{}", root),
    ).toThrow(WriteOutsideAllowlistError);
  });
});

describe("the review file across consecutive runs", () => {
  const { adapter, config: leverConfig } = leverSource;
  const postings = adapter.selectLocal(
    adapter.parseListing(
      readFileSync(
        new URL("./__fixtures__/lever-insomnia/listing.json", import.meta.url),
        "utf-8",
      ),
    ).entries,
    leverConfig,
  );

  // The block lever-cli.ts runs behind --write-review, against a temporary
  // root so the run touches no file the live board is built from.
  function runOnce(
    state: SourcesState,
    found: typeof postings,
    now: Date,
  ): { state: SourcesState; rows: number } {
    const result = recordRun(
      state,
      SOURCE_ID,
      found.map((posting) => ({
        key: postingKey(SOURCE_ID, posting.id),
        title: posting.title,
        url: posting.applyLink,
      })),
      now,
    );
    const owed = new Set(result.unreported.map((posting) => posting.key));
    const fresh = found.filter((posting) =>
      owed.has(postingKey(SOURCE_ID, posting.id)),
    );

    const target = writeReviewCsv(fresh.map(toReviewJob), root);
    const rows = parseCsv(readFileSync(target, "utf-8"), {
      record_delimiter: ["\r\n", "\n", "\r"],
    }) as string[][];

    return {
      state: pruneSourcesState(markReported(result.state, [...owed]), now),
      rows: rows.length - 1,
    };
  }

  it("hands the reviewer every posting once and never again", () => {
    expect(postings.length).toBeGreaterThan(0);

    const first = runOnce(emptyState(), postings, at(0));
    expect(first.rows).toBe(postings.length);

    const second = runOnce(first.state, postings, at(1));
    expect(second.rows).toBe(0);

    const third = runOnce(second.state, postings, at(2));
    expect(third.rows).toBe(0);
  });
});
