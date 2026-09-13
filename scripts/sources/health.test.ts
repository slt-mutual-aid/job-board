import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  HEALTH_FILE_PATH,
  assess,
  exitCodeFor,
  formatRunSummary,
  observedFailure,
  previousCountOf,
  readHealthFile,
  recordRun,
  type SourceAssessment,
  type SourceObservation,
} from "./health";
import { REPOSITORY_ROOT } from "./review-csv";
import { SourceResponseError } from "./types";

const SOURCE = "lever";
const OTHER_SOURCE = "bamboohr";

// A run at a fixed instant, so a recorded timestamp is a fact the test states
// rather than whatever the machine clock read.
const NOW = new Date("2026-03-04T17:30:00.000Z");
const EARLIER = new Date("2026-03-03T17:30:00.000Z");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "source-health-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A reading whose response carried exactly the postings the location filter
// kept, which is the ordinary case. entryCount is stated where the two differ.
function reading(
  postingCount: number,
  confirmedEmpty = postingCount === 0,
  sourceId = SOURCE,
  entryCount = postingCount,
): SourceObservation<string> {
  return {
    kind: "reading",
    sourceId,
    postings: Array.from(
      { length: postingCount },
      (_, index) => `posting-${index}`,
    ),
    entryCount,
    confirmedEmpty,
  };
}

function writeHealthFileText(text: string): void {
  const target = join(root, HEALTH_FILE_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf-8");
}

// Lays down the history a run compares against by recording earlier runs the
// same way a real run would.
function seed(counts: readonly number[], sourceId = SOURCE): void {
  for (const count of counts) {
    recordRun([reading(count, count === 0, sourceId)], { now: EARLIER, root });
  }
}

function run(observation: SourceObservation<string>): SourceAssessment<string> {
  return recordRun([observation], { now: NOW, root })[0];
}

function historyCounts(sourceId = SOURCE): number[] {
  return readHealthFile(root).sources[sourceId].history.map(
    (entry) => entry.count,
  );
}

describe("source health rules", () => {
  it("reports a thrown error as an error rather than as no postings", () => {
    seed([5]);

    const assessment = run(
      observedFailure(SOURCE, new SourceResponseError("container renamed")),
    );

    expect(assessment.status).toBe("error");
    expect(assessment.postingCount).toBeNull();
    expect(assessment.detail).toContain("container renamed");
  });

  it("reports a zero the response never confirmed as an error with no count", () => {
    const assessment = run(reading(0, false));

    expect(assessment.status).toBe("error");
    // A count of zero beside a status of error is the conflation the whole
    // module exists to prevent: the parser lost every posting, so no count was
    // ever read.
    expect(assessment.postingCount).toBeNull();
  });

  it("accepts a zero the location filter produced from a full response", () => {
    // The BambooHR listing covers a whole company, so a week whose only
    // openings sit in Truckee is an ordinary week rather than a broken source.
    const assessment = run(reading(0, false, SOURCE, 5));

    expect(assessment.status).toBe("healthy");
  });

  it("accepts a confirmed zero on a first run with no history", () => {
    const assessment = run(reading(0, true));

    expect(assessment.status).toBe("healthy");
    expect(assessment.previousCount).toBeNull();
  });

  it("flags a confirmed zero where the previous run found postings", () => {
    seed([3]);

    const assessment = run(reading(0, true));

    expect(assessment.status).toBe("suspicious-zero");
    expect(assessment.previousCount).toBe(3);
    // Zero here is a count the run actually read, which is what separates a
    // vanished source from a parser that never reached a count at all.
    expect(assessment.postingCount).toBe(0);
  });

  it("accepts a confirmed zero where the previous run also found nothing", () => {
    seed([0]);

    expect(run(reading(0, true)).status).toBe("healthy");
  });

  it("flags a count that falls below half the previous count", () => {
    seed([4]);

    const assessment = run(reading(1));

    expect(assessment.status).toBe("suspicious-drop");
    expect(assessment.postingCount).toBe(1);
    expect(assessment.detail).toBe(
      "1 posting, down from 4 on the previous run",
    );
  });

  it("counts one posting once in a healthy detail line", () => {
    seed([1]);

    expect(run(reading(1)).detail).toBe("1 posting, 1 on the previous run");
    expect(run(reading(2)).detail).toBe("2 postings, 1 on the previous run");
  });

  it("counts one posting once on a first run", () => {
    expect(run(reading(1)).detail).toBe("1 posting, no previous run on record");
  });

  it("accepts a drop that stops at half the previous count", () => {
    seed([4]);

    expect(run(reading(2)).status).toBe("healthy");
  });

  it("accepts the same fall where the previous count was under four", () => {
    seed([3]);

    expect(run(reading(1)).status).toBe("healthy");
  });

  it("compares against the last run that produced a count", () => {
    seed([6]);
    recordRun([observedFailure(SOURCE, new Error("timeout"))], {
      now: EARLIER,
      root,
    });

    // A failure that reset the baseline to zero would let a source stay broken
    // and be read as quiet from the second run onward.
    expect(run(reading(0, true)).status).toBe("suspicious-zero");
  });

  it("keeps reporting a confirmed zero instead of adopting it as the baseline", () => {
    seed([5, 5]);

    const statuses = [
      run(reading(0, true)),
      run(reading(0, true)),
      run(reading(0, true)),
    ].map((assessment) => assessment.status);

    // A suspicious count that reached the history would be the next run's
    // baseline, and the break would read as healthy one run later.
    expect(statuses).toEqual([
      "suspicious-zero",
      "suspicious-zero",
      "suspicious-zero",
    ]);
    expect(historyCounts()).toEqual([5, 5]);
    expect(readHealthFile(root).sources[SOURCE].lastSuccessfulRunAt).toBe(
      EARLIER.toISOString(),
    );
  });

  it("keeps reporting a drop instead of adopting it as the baseline", () => {
    seed([8]);

    expect(run(reading(1)).status).toBe("suspicious-drop");
    expect(run(reading(1)).status).toBe("suspicious-drop");
    expect(historyCounts()).toEqual([8]);
    expect(readHealthFile(root).sources[SOURCE].lastSuccessfulRunAt).toBe(
      EARLIER.toISOString(),
    );
  });
});

describe("source health consequences", () => {
  it("stops the run on an error or a vanished source", () => {
    const failed = assess(observedFailure(SOURCE, new Error("timeout")), 5);
    const vanished = assess(reading(0, true), 5);
    const dropped = assess(reading(1), 8);
    const healthy = assess(reading(5), 5);

    expect(exitCodeFor([failed])).toBe(1);
    expect(exitCodeFor([vanished])).toBe(1);
    expect(exitCodeFor([dropped])).toBe(0);
    expect(exitCodeFor([healthy])).toBe(0);
    expect(exitCodeFor([healthy, vanished])).toBe(1);
  });

  it("carries the postings only on the shape the rules found healthy", () => {
    const healthy = assess(reading(2), 2);
    if (healthy.status !== "healthy") {
      throw new Error(`expected a healthy assessment, got ${healthy.status}`);
    }
    expect(healthy.postings).toEqual(["posting-0", "posting-1"]);

    for (const unfit of [
      assess(observedFailure(SOURCE, new Error("timeout")), 5),
      assess(reading(0, true), 5),
      assess(reading(1), 8),
      assess(reading(0, false), 5),
    ]) {
      expect(unfit.status).not.toBe("healthy");
      // A broken adapter hands a caller nothing to mistake for the complete
      // set of open postings.
      expect("postings" in unfit).toBe(false);
    }
  });

  it("refuses the postings to a caller that skipped the status", () => {
    const unfit: SourceAssessment<string> = assess(reading(0, true), 5);

    // @ts-expect-error the postings are unreachable without narrowing to healthy
    expect(unfit.postings).toBeUndefined();
  });

  it("lists every source in the summary, including one that found nothing", () => {
    const assessments = recordRun(
      [reading(2), reading(0, true, OTHER_SOURCE)],
      {
        now: NOW,
        root,
      },
    );

    const summary = formatRunSummary(assessments);

    expect(summary).toContain(SOURCE);
    expect(summary).toContain(OTHER_SOURCE);
    expect(summary.split("\n")).toHaveLength(3);
  });

  it("prints no count for a source whose request failed", () => {
    const summary = formatRunSummary([
      run(observedFailure(SOURCE, new Error("timeout"))),
    ]);

    expect(summary).toContain("-");
    expect(summary).not.toContain(" 0 ");
  });

  it("prints no count for a response that lost every posting", () => {
    seed([4]);

    const summary = formatRunSummary([run(reading(0, false))]);
    const [, row] = summary.split("\n");

    // A found count of zero would tell a reader the employer has no openings,
    // when the fact on record is that the parser read nothing at all.
    expect(row.split(/\s{2,}/)[2]).toBe("-");
  });
});

describe("source health file", () => {
  it("records the run time, the last successful run, and the counts", () => {
    seed([2]);

    recordRun([reading(3)], { now: NOW, root });
    const record = readHealthFile(root).sources[SOURCE];

    expect(record.lastRunAt).toBe(NOW.toISOString());
    expect(record.lastSuccessfulRunAt).toBe(NOW.toISOString());
    expect(record.history.map((entry) => entry.count)).toEqual([2, 3]);
  });

  it("leaves the last successful run where it was after a failure", () => {
    seed([2]);

    recordRun([observedFailure(SOURCE, new Error("timeout"))], {
      now: NOW,
      root,
    });
    const record = readHealthFile(root).sources[SOURCE];

    expect(record.lastRunAt).toBe(NOW.toISOString());
    expect(record.lastSuccessfulRunAt).toBe(EARLIER.toISOString());
    expect(record.history).toHaveLength(1);
  });

  it("records no count for a zero the response never confirmed", () => {
    seed([2]);

    recordRun([reading(0, false)], { now: NOW, root });
    const record = readHealthFile(root).sources[SOURCE];

    // A zero the parser could not confirm is an error, and an error that
    // reached the history would become the next run's baseline.
    expect(record.history.map((entry) => entry.count)).toEqual([2]);
    expect(record.lastSuccessfulRunAt).toBe(EARLIER.toISOString());
  });

  it("keeps a short rolling history", () => {
    seed([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const { history } = readHealthFile(root).sources[SOURCE];

    expect(history).toHaveLength(10);
    expect(history[history.length - 1].count).toBe(12);
  });

  it("writes inside the allowed data directory", () => {
    recordRun([reading(1)], { now: NOW, root });

    expect(HEALTH_FILE_PATH).toBe(
      join("scripts", "data", "source-health.json"),
    );
    expect(readFileSync(join(root, HEALTH_FILE_PATH), "utf-8")).toContain(
      SOURCE,
    );
  });

  it("reads an absent file as no history without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readHealthFile(root)).toEqual({ sources: {} });
    expect(previousCountOf(readHealthFile(root), SOURCE)).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("says out loud that it read a damaged file as no history", () => {
    writeHealthFileText("{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The quiet version of the fallback looks exactly like a genuine first run
    // while the drop and suspicious-zero rules sit disabled.
    expect(readHealthFile(root)).toEqual({ sources: {} });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(HEALTH_FILE_PATH),
    );

    warn.mockRestore();
  });

  it("says out loud that it dropped a record whose shape it cannot read", () => {
    writeHealthFileText(
      JSON.stringify({
        sources: {
          [SOURCE]: { lastRunAt: 7, history: "yesterday" },
          [OTHER_SOURCE]: {
            lastRunAt: EARLIER.toISOString(),
            lastSuccessfulRunAt: EARLIER.toISOString(),
            history: [{ at: EARLIER.toISOString(), count: 4 }],
          },
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const file = readHealthFile(root);

    expect(file.sources[SOURCE]).toBeUndefined();
    expect(previousCountOf(file, OTHER_SOURCE)).toBe(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SOURCE));

    warn.mockRestore();
  });

  it("keeps the history of a record that names no successful run", () => {
    const at = EARLIER.toISOString();
    writeHealthFileText(
      JSON.stringify({
        sources: {
          [SOURCE]: { lastRunAt: at, history: [{ at, count: 4 }] },
        },
      }),
    );

    // A key a hand edit dropped costs the source its history, and a source with
    // no history reports a first run in good health.
    expect(previousCountOf(readHealthFile(root), SOURCE)).toBe(4);
    expect(readHealthFile(root).sources[SOURCE].lastSuccessfulRunAt).toBeNull();
  });

  it("keeps the readable history around an entry it cannot read", () => {
    const at = EARLIER.toISOString();
    writeHealthFileText(
      JSON.stringify({
        sources: {
          [SOURCE]: {
            lastRunAt: at,
            lastSuccessfulRunAt: at,
            history: [
              { at, count: 5 },
              { at, count: "12" },
              { at, count: 5 },
            ],
          },
        },
      }),
    );

    // Dropping the record over one bad entry disables the rules for the source
    // and then reports it as a first run reporting healthy, which fails open.
    expect(previousCountOf(readHealthFile(root), SOURCE)).toBe(5);
    expect(readHealthFile(root).sources[SOURCE].history).toHaveLength(2);
    expect(run(reading(0, true)).status).toBe("suspicious-zero");
  });
});

describe("source health in automation", () => {
  function workflowText(): string {
    return readFileSync(
      join(REPOSITORY_ROOT, ".github", "workflows", "source-health.yml"),
      "utf-8",
    );
  }

  it("runs the check on a caller other than a person's laptop", () => {
    const workflow = workflowText();

    expect(workflow).toContain("yarn sources:health");
    expect(workflow).toMatch(/^on:/m);
    expect(workflow).toMatch(/^permissions:/m);
  });

  it("persists the history the rules compare against", () => {
    // The rules compare one run against the previous run, so a history the job
    // leaves behind when it ends takes both rules out of automation entirely.
    const workflow = workflowText();

    expect(workflow).toContain(`git add ${HEALTH_FILE_PATH}`);
    expect(workflow).toContain("git push");
  });

  it("keeps the history file out of the ignore rules", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", HEALTH_FILE_PATH], {
      cwd: REPOSITORY_ROOT,
    });
    const tracked = spawnSync("git", ["ls-files", HEALTH_FILE_PATH], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf-8",
    });

    expect(ignored.status).toBe(1);
    expect(tracked.stdout.trim()).toBe(HEALTH_FILE_PATH);
  });
});
