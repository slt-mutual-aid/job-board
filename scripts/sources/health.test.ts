import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  HEALTH_FILE_PATH,
  allowsRemovalConclusions,
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

function reading(
  postingCount: number,
  confirmedEmpty = postingCount === 0,
  sourceId = SOURCE,
): SourceObservation {
  return { kind: "reading", sourceId, postingCount, confirmedEmpty };
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

function run(observation: SourceObservation): SourceAssessment {
  return recordRun([observation], { now: NOW, root })[0];
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

  it("reports a zero the response never confirmed as an error", () => {
    const assessment = run(reading(0, false));

    expect(assessment.status).toBe("error");
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
  });

  it("accepts a confirmed zero where the previous run also found nothing", () => {
    seed([0]);

    expect(run(reading(0, true)).status).toBe("healthy");
  });

  it("flags a count that falls below half the previous count", () => {
    seed([4]);

    const assessment = run(reading(1));

    expect(assessment.status).toBe("suspicious-drop");
    expect(assessment.detail).toBe(
      "1 postings, down from 4 on the previous run",
    );
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
});

describe("source health consequences", () => {
  it("stops the run on an error or a vanished source", () => {
    const at = (status: SourceAssessment["status"]): SourceAssessment[] => [
      {
        sourceId: SOURCE,
        status,
        postingCount: 0,
        previousCount: 1,
        detail: "",
      },
    ];

    expect(exitCodeFor(at("error"))).toBe(1);
    expect(exitCodeFor(at("suspicious-zero"))).toBe(1);
    expect(exitCodeFor(at("suspicious-drop"))).toBe(0);
    expect(exitCodeFor(at("healthy"))).toBe(0);
  });

  it("allows removal conclusions only for a healthy source", () => {
    seed([5]);

    expect(allowsRemovalConclusions(run(reading(5)))).toBe(true);
    expect(
      allowsRemovalConclusions(
        assess(observedFailure(SOURCE, new Error("timeout")), 5),
      ),
    ).toBe(false);
    expect(allowsRemovalConclusions(assess(reading(0, true), 5))).toBe(false);
    expect(allowsRemovalConclusions(assess(reading(1), 8))).toBe(false);
  });

  it("lists every source in the summary, including one that found nothing", () => {
    const assessments = recordRun(
      [reading(2), reading(0, true, OTHER_SOURCE)],
      { now: NOW, root },
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

  it("reads an absent file as no history", () => {
    expect(readHealthFile(root)).toEqual({ sources: {} });
    expect(previousCountOf(readHealthFile(root), SOURCE)).toBeNull();
  });

  it("reads a malformed file as no history rather than crashing", () => {
    writeHealthFileText("{ not json");

    expect(readHealthFile(root)).toEqual({ sources: {} });
    expect(run(reading(0, true)).status).toBe("healthy");
  });

  it("drops a record whose shape it cannot read", () => {
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

    const file = readHealthFile(root);

    expect(file.sources[SOURCE]).toBeUndefined();
    expect(previousCountOf(file, OTHER_SOURCE)).toBe(4);
  });
});
