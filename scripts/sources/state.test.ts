import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { WriteOutsideAllowlistError, writeAllowedFile } from "./review-csv";
import { leverSource } from "./registry";
import {
  PRUNE_AFTER_DAYS,
  SOURCES_STATE_PATH,
  emptyState,
  loadSourcesState,
  markDecided,
  postingKey,
  pruneSourcesState,
  recordRun,
  saveSourcesState,
  type SeenPosting,
} from "./state";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const SOURCE_ID = leverSource.accountId;

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
  it("queues every posting on the first run", () => {
    const { undecided } = recordRun(
      emptyState(),
      [posting("abc"), posting("def")],
      at(0),
    );

    expect(undecided.map((entry) => entry.key)).toEqual([
      postingKey(SOURCE_ID, "abc"),
      postingKey(SOURCE_ID, "def"),
    ]);
  });

  it("queues nothing the reviewer has decided about", () => {
    const postings = [posting("abc"), posting("def")];
    const first = recordRun(emptyState(), postings, at(0));
    const decided = markDecided(
      first.state,
      first.undecided.map((entry) => entry.key),
    );

    const second = recordRun(decided, postings, at(1));

    expect(second.undecided).toEqual([]);
  });

  it("queues a posting again while no decision stands against it", () => {
    const first = recordRun(emptyState(), [posting("abc")], at(0));

    // Nobody typed a decision between the two runs, so the posting belongs in
    // the review file the second run writes.
    const second = recordRun(first.state, [posting("abc")], at(1));

    expect(second.undecided.map((entry) => entry.key)).toEqual([
      postingKey(SOURCE_ID, "abc"),
    ]);
  });

  it("advances the last sighting", () => {
    const first = recordRun(emptyState(), [posting("abc")], at(0));
    const second = recordRun(first.state, [posting("abc")], at(3));

    expect(second.state.postings[postingKey(SOURCE_ID, "abc")].lastSeen).toBe(
      at(3).toISOString(),
    );
  });

  it("records the title and the url of each posting", () => {
    const { state } = recordRun(
      emptyState(),
      [posting("abc", "Shift Lead")],
      at(0),
    );

    const record = state.postings[postingKey(SOURCE_ID, "abc")];
    expect(record.title).toBe("Shift Lead");
    expect(record.url).toBe(
      "https://jobs.lever.co/insomniacookies/abc?source=slt",
    );
  });

  it("holds a decision through a posting disappearing and returning", () => {
    const first = recordRun(emptyState(), [posting("abc")], at(0));
    const decided = markDecided(
      first.state,
      first.undecided.map((entry) => entry.key),
    );

    const gone = recordRun(decided, [], at(1));
    const back = recordRun(gone.state, [posting("abc")], at(2));

    expect(back.undecided).toEqual([]);
  });
});

describe("pruneSourcesState", () => {
  it("drops a posting not seen for the whole prune interval", () => {
    const { state } = recordRun(emptyState(), [posting("abc")], at(0));

    const pruned = pruneSourcesState(state, at(PRUNE_AFTER_DAYS + 1));

    expect(pruned.postings).toEqual({});
  });

  it("keeps a posting seen inside the prune interval", () => {
    const { state } = recordRun(emptyState(), [posting("abc")], at(0));

    const pruned = pruneSourcesState(state, at(PRUNE_AFTER_DAYS - 1));

    expect(Object.keys(pruned.postings)).toEqual([
      postingKey(SOURCE_ID, "abc"),
    ]);
  });
});

describe("loadSourcesState", () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads back what saveSourcesState wrote", () => {
    const { state } = recordRun(emptyState(), [posting("abc")], at(0));
    saveSourcesState(state, root);

    expect(loadSourcesState(root)).toEqual(state);
  });

  it("treats an absent file as a first run without a warning", () => {
    expect(loadSourcesState(root)).toEqual(emptyState());
    expect(warnings).toEqual([]);
  });

  it("warns about a file that is not JSON", () => {
    writeRawState("{ not json");

    expect(loadSourcesState(root)).toEqual(emptyState());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SOURCES_STATE_PATH);
  });

  it("warns about a JSON file of the wrong shape", () => {
    writeRawState('["abc"]');

    expect(loadSourcesState(root)).toEqual(emptyState());
    expect(warnings).toHaveLength(1);
  });

  it("warns about a file that cannot be read at all", () => {
    // A directory where the file belongs fails the read with EISDIR, which is
    // the shape of every unreadable file the command can meet.
    mkdirSync(join(root, SOURCES_STATE_PATH), { recursive: true });

    expect(loadSourcesState(root)).toEqual(emptyState());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SOURCES_STATE_PATH);
  });

  it("keeps the sound records of a file carrying one broken posting", () => {
    writeRawState(
      JSON.stringify({
        postings: {
          "lever:insomniacookies:abc": {
            lastSeen: "2026-01-01T00:00:00.000Z",
            title: "Cookie Crew",
            url: "https://jobs.lever.co/insomniacookies/abc",
            decided: true,
          },
          "lever:insomniacookies:def": { decided: "yes" },
        },
      }),
    );

    const state = loadSourcesState(root);

    expect(Object.keys(state.postings)).toEqual(["lever:insomniacookies:abc"]);
  });

  it("keeps the sound records of a file carrying one broken missing record", () => {
    writeRawState(
      JSON.stringify({
        postings: {},
        missing: {
          "lever:insomniacookies:abc": {
            misses: 2,
            firstMissedAt: "2026-01-01T00:00:00.000Z",
            lastMissedAt: "2026-01-02T00:00:00.000Z",
          },
          "lever:insomniacookies:def": { misses: 0 },
        },
      }),
    );

    expect(Object.keys(loadSourcesState(root).missing)).toEqual([
      "lever:insomniacookies:abc",
    ]);
  });

  it("drops a missing record whose count is not a whole number of runs", () => {
    writeRawState(
      JSON.stringify({
        postings: {},
        missing: {
          "lever:insomniacookies:abc": {
            misses: 1.5,
            firstMissedAt: "2026-01-01T00:00:00.000Z",
            lastMissedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
    );

    expect(loadSourcesState(root).missing).toEqual({});
  });

  it("drops a missing record whose timestamp cannot be read as a date", () => {
    writeRawState(
      JSON.stringify({
        postings: {},
        missing: {
          "lever:insomniacookies:abc": {
            misses: 2,
            firstMissedAt: "whenever",
            lastMissedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
    );

    expect(loadSourcesState(root).missing).toEqual({});
  });

  it("drops a posting whose timestamp cannot be read as a date", () => {
    writeRawState(
      JSON.stringify({
        postings: {
          "lever:insomniacookies:abc": {
            lastSeen: "whenever",
            title: "Cookie Crew",
            url: "https://jobs.lever.co/insomniacookies/abc",
            decided: true,
          },
        },
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
