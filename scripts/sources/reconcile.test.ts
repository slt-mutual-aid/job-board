import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { assess, type SourceAssessment } from "./health";
import {
  bambooHrSource,
  icimsDavidsonSource,
  icimsOvgSource,
  leverSource,
  oracleCaesarsSource,
  oracleRaleysSource,
  sources,
  ukgSource,
} from "./registry";
import {
  REPOSITORY_ROOT,
  WriteOutsideAllowlistError,
  writeAllowedFile,
} from "./review-csv";
import {
  COVERED_SOURCE_IDS,
  MISSES_BEFORE_REMOVAL,
  RECONCILE_REPORT_PATH,
  matchBoardRow,
  readBoardRows,
  reconcileToDisk,
  type BoardRow,
} from "./reconcile";
import { loadSourcesState, postingKey } from "./state";
import type { IdentifiedEntry } from "./types";

const LEVER_ID = leverSource.sourceId;
const BAMBOOHR_ID = bambooHrSource.sourceId;
const ORACLE_CAESARS_ID = oracleCaesarsSource.sourceId;
const ORACLE_RALEYS_ID = oracleRaleysSource.sourceId;
const UKG_ID = ukgSource.sourceId;

function ukgLink(postingId: string): string {
  const { tenant, jobBoardId } = ukgSource.config;
  return `https://recruiting.ultipro.com/${tenant}/JobBoard/${jobBoardId}/OpportunityDetail?opportunityId=${postingId}`;
}

// The career site writes a posting page in both of these shapes, and the board
// carries rows in each.
function oracleJobLink(host: string, postingId: string): string {
  return `https://${host}/hcmUI/CandidateExperience/en/sites/CX_1/job/${postingId}/`;
}

function oraclePreviewLink(host: string, postingId: string): string {
  return `https://${host}/hcmUI/CandidateExperience/en/sites/CX_1/jobs/preview/${postingId}/`;
}

function fixture(name: string): string {
  return readFileSync(
    resolve(REPOSITORY_ROOT, "scripts", "sources", "__fixtures__", name),
    "utf-8",
  );
}

function leverFixturePostings(): IdentifiedEntry[] {
  const { entries } = leverSource.adapter.parseListing(
    fixture("lever-insomnia/listing.json"),
  );
  return leverSource.adapter.selectLocal(entries, leverSource.config);
}

function bambooHrFixturePostings(): IdentifiedEntry[] {
  const { entries } = bambooHrSource.adapter.parseListing(
    fixture("bamboohr-vra/listing.json"),
  );
  return bambooHrSource.adapter.selectLocal(entries, bambooHrSource.config);
}

const LISTED_LEVER_POSTINGS = leverFixturePostings();
const LISTED_LEVER_ID = LISTED_LEVER_POSTINGS[0].id;
const LISTED_BAMBOOHR_POSTINGS = bambooHrFixturePostings();
const LISTED_BAMBOOHR_ID = LISTED_BAMBOOHR_POSTINGS[0].id;

// A posting the recorded listing does not carry, taken from the board itself so
// the absence is the one the tool exists to report rather than an invented one.
const WITHDRAWN_LEVER_ID = "9176727b-af98-4eb0-a1aa-980f826d9c92";

function leverLink(postingId: string): string {
  return `https://jobs.lever.co/${leverSource.config.company}/${postingId}`;
}

function bambooHrLink(postingId: string): string {
  return `https://${bambooHrSource.config.subdomain}.bamboohr.com/careers/${postingId}`;
}

function boardRow(id: number, applyLink: string): BoardRow {
  return {
    id,
    company: "Insomnia Cookies",
    title: "Delivery Driver",
    applyLink,
  };
}

function boardOf(rows: readonly BoardRow[]) {
  return { rows: [...rows], total: rows.length };
}

function healthy(
  sourceId: string,
  postings: readonly IdentifiedEntry[],
): SourceAssessment<IdentifiedEntry> {
  return assess(
    {
      kind: "reading",
      sourceId,
      postings,
      entryCount: postings.length,
      confirmedEmpty: postings.length === 0,
    },
    null,
  );
}

const postingsOnPreviousRun = 3;

function failed(sourceId: string): SourceAssessment<IdentifiedEntry> {
  return assess(
    { kind: "failure", sourceId, message: "HttpError: 503" },
    postingsOnPreviousRun,
  );
}

function suspiciousZero(sourceId: string): SourceAssessment<IdentifiedEntry> {
  return assess(
    {
      kind: "reading",
      sourceId,
      postings: [],
      entryCount: 0,
      confirmedEmpty: true,
    },
    postingsOnPreviousRun,
  );
}

describe("board row matching", () => {
  const covered: Array<[string, string, string]> = [
    [leverLink(LISTED_LEVER_ID), LEVER_ID, LISTED_LEVER_ID],
    [bambooHrLink("34"), BAMBOOHR_ID, "34"],
    [
      oracleJobLink(oracleCaesarsSource.config.host, "85594"),
      ORACLE_CAESARS_ID,
      "85594",
    ],
    [
      oraclePreviewLink(oracleCaesarsSource.config.host, "85024"),
      ORACLE_CAESARS_ID,
      "85024",
    ],
    [
      oracleJobLink(oracleRaleysSource.config.host, "16143"),
      ORACLE_RALEYS_ID,
      "16143",
    ],
    [
      ukgLink("a127e612-9821-4a77-be3b-bf13bf388762"),
      UKG_ID,
      "a127e612-9821-4a77-be3b-bf13bf388762",
    ],
  ];

  it.each(covered)(
    "reads %s as a posting of a known source",
    (link, sourceId, postingId) => {
      expect(matchBoardRow(boardRow(1, link))).toEqual({
        sourceId,
        postingId,
        key: expect.stringContaining(postingId),
      });
    },
  );

  const ignored = [
    // Every link below is on the committed board and belongs to a platform no
    // adapter reads. A guess about any of them would be a guess about a row
    // nothing verified.
    "https://www.indeed.com/viewjob?cmp=Riva-Grill&jk=fc954657a71c2331",
    "https://savemart.csod.com/ux/ats/careersite/25/home/requisition/41554?c=savemart",
    "https://theburkscompanies.applicantpro.com/jobs/3540383",
    "https://careers.wholefoods.com/seafood-team-member/job/PAF-WFM-17AD7D8C",
    // A different Lever account, a different BambooHR account, and an iCIMS
    // account neither configuration names.
    "https://jobs.lever.co/someoneelse/9176727b-af98-4eb0-a1aa-980f826d9c92",
    "https://other.bamboohr.com/careers/34",
    "https://careers-someoneelse.icims.com/jobs/33051/banquet-server/job",
    // Another UKG customer, and another job board of the same customer.
    `https://recruiting.ultipro.com/OTH1000OTHR/JobBoard/${ukgSource.config.jobBoardId}/OpportunityDetail?opportunityId=a127e612-9821-4a77-be3b-bf13bf388762`,
    `https://recruiting.ultipro.com/${ukgSource.config.tenant}/JobBoard/00000000-0000-0000-0000-000000000000/OpportunityDetail?opportunityId=a127e612-9821-4a77-be3b-bf13bf388762`,
    // A third employer on Oracle HCM Cloud, on a host neither config names.
    "https://other.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/85594/",
    // The internal candidate site on a covered host, which lists postings this
    // board cannot send a job seeker to.
    `https://${oracleCaesarsSource.config.host}/hcmUI/CandidateExperience/en/sites/CX_2/job/85594/`,
    // Shapes the hosts do not use for a posting page.
    "https://jobs.lever.co/insomniacookies",
    "https://careers-ovg.icims.com/jobs/search?ss=1",
    "https://careers-ovg.icims.com/jobs/33051/banquet-server",
    `https://${bambooHrSource.config.subdomain}.bamboohr.com/careers/34/detail`,
    `https://${bambooHrSource.config.subdomain}.bamboohr.com/careers/list`,
    ukgLink(""),
    `https://${oracleCaesarsSource.config.host}/hcmUI/CandidateExperience/en/sites/CX_1/job/`,
    `https://${oracleCaesarsSource.config.host}/hcmUI/CandidateExperience/en/sites/CX_1/job/not-a-number/`,
    "not a url",
  ];

  it.each(ignored)("reads %s as a row no adapter covers", (link) => {
    expect(matchBoardRow(boardRow(1, link))).toBeNull();
  });

  it("carries a link rule for every source the registry lists", () => {
    expect([...COVERED_SOURCE_IDS].sort()).toEqual(
      sources.map((source) => source.sourceId).sort(),
    );
  });

  it.each([
    ["https://careers-ovg.icims.com/jobs/33051/banquet-server/job", "33051"],
    [
      "https://careers-davidsonhospitality.icims.com/jobs/26309/housekeeping-room-attendant/job?hub=10",
      "26309",
    ],
    // The spreadsheet was filled in from the host the employer advertised,
    // which is not the host the listing is read from.
    [
      "https://jobs-davidsonhospitality.icims.com/jobs/26309/housekeeping-room-attendant/job",
      "26309",
    ],
  ])("reads %s as iCIMS posting %s", (link, postingId) => {
    expect(matchBoardRow(boardRow(1, link))?.postingId).toBe(postingId);
  });

  it("matches only the committed board rows that live on a covered host", () => {
    const { rows, total } = readBoardRows(REPOSITORY_ROOT);
    const coveredHosts = [
      "jobs.lever.co",
      `${bambooHrSource.config.subdomain}.bamboohr.com`,
      ...icimsOvgSource.config.linkHosts,
      ...icimsDavidsonSource.config.linkHosts,
      oracleCaesarsSource.config.host,
      oracleRaleysSource.config.host,
      "recruiting.ultipro.com",
    ];

    const matched = rows.filter((row) => matchBoardRow(row) !== null);
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.length).toBeLessThan(total);

    for (const row of rows) {
      const onCoveredHost = coveredHosts.includes(new URL(row.applyLink).host);
      if (!onCoveredHost) {
        expect(matchBoardRow(row)).toBeNull();
      }
    }
  });
});

describe("reconciliation against a working directory", () => {
  let root: string;
  const firstRun = new Date("2026-03-01T12:00:00.000Z");
  const secondRun = new Date("2026-03-02T12:00:00.000Z");
  const thirdRun = new Date("2026-03-03T12:00:00.000Z");

  const listedRow = boardRow(1, leverLink(LISTED_LEVER_ID));
  const withdrawnRow = boardRow(2, leverLink(WITHDRAWN_LEVER_ID));
  const uncoveredRow = boardRow(
    3,
    "https://www.indeed.com/viewjob?cmp=Riva-Grill&jk=fc954657a71c2331",
  );
  const board = boardOf([listedRow, withdrawnRow, uncoveredRow]);
  const withdrawnKey = postingKey(leverSource.accountId, WITHDRAWN_LEVER_ID);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reconcile-"));
    mkdirSync(join(root, "scripts", "data"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(
    assessments: readonly SourceAssessment<IdentifiedEntry>[],
    now: Date,
  ) {
    return reconcileToDisk(board, assessments, now, root);
  }

  const listing = [healthy(LEVER_ID, LISTED_LEVER_POSTINGS)];

  it("says nothing about a posting the listing still carries", () => {
    const { result, target } = run(listing, firstRun);

    const named = [...result.recommended, ...result.watching];
    expect(named.map((posting) => posting.row.id)).not.toContain(listedRow.id);
    expect(
      result.state.missing[postingKey(leverSource.accountId, LISTED_LEVER_ID)],
    ).toBeUndefined();
    expect(readFileSync(target, "utf-8")).not.toContain(listedRow.applyLink);
  });

  it("watches a posting the listing missed once without recommending it", () => {
    const { result, target } = run(listing, firstRun);

    expect(result.recommended).toEqual([]);
    expect(result.watching.map((posting) => posting.row.id)).toEqual([
      withdrawnRow.id,
    ]);
    expect(loadSourcesState(root).missing[withdrawnKey]).toEqual({
      misses: 1,
      firstMissedAt: firstRun.toISOString(),
      lastMissedAt: firstRun.toISOString(),
    });

    const report = readFileSync(target, "utf-8");
    expect(report).toContain("Recommended for removal (0)");
    expect(report).toContain(withdrawnRow.applyLink);
  });

  it("recommends a posting two consecutive healthy listings missed", () => {
    run(listing, firstRun);
    const { result, target } = run(listing, secondRun);

    expect(result.watching).toEqual([]);
    expect(result.recommended).toHaveLength(1);

    const [posting] = result.recommended;
    expect(posting.record.misses).toBe(MISSES_BEFORE_REMOVAL);
    expect(posting.record.firstMissedAt).toBe(firstRun.toISOString());

    const report = readFileSync(target, "utf-8");
    expect(report).toContain("Recommended for removal (1)");
    for (const evidence of [
      withdrawnRow.company,
      withdrawnRow.title,
      withdrawnRow.applyLink,
      posting.reason,
    ]) {
      expect(report).toContain(evidence);
    }
    expect(report).toContain(
      "A person confirms each posting and removes the row from the spreadsheet.",
    );
  });

  it("clears the watch when a posting returns to the listing", () => {
    run(listing, firstRun);

    const returned = [
      healthy(LEVER_ID, [...LISTED_LEVER_POSTINGS, { id: WITHDRAWN_LEVER_ID }]),
    ];
    const back = run(returned, secondRun);
    expect(back.result.state.missing).toEqual({});

    // The next absence starts the count again rather than resuming it.
    const missedAgain = run(listing, thirdRun);
    expect(missedAgain.result.recommended).toEqual([]);
    expect(missedAgain.result.state.missing[withdrawnKey]).toEqual({
      misses: 1,
      firstMissedAt: thirdRun.toISOString(),
      lastMissedAt: thirdRun.toISOString(),
    });
  });

  it.each([
    ["a failed request", failed(LEVER_ID)],
    ["a listing that lost every posting", suspiciousZero(LEVER_ID)],
  ])("draws no conclusion from %s", (_label, assessment) => {
    run(listing, firstRun);
    const { result, target } = run([assessment], secondRun);

    expect(result.recommended).toEqual([]);
    expect(result.watching).toEqual([]);
    // The watch the healthy run left is neither advanced nor cleared.
    expect(result.state.missing[withdrawnKey].misses).toBe(1);
    expect(result.unreconciled).toEqual([
      {
        sourceId: LEVER_ID,
        status: assessment.status,
        detail: assessment.detail,
        coveredRows: 2,
      },
    ]);
    expect(readFileSync(target, "utf-8")).toContain(
      "Sources that produced no conclusions",
    );
  });

  it("reports a covered row whose source the run never read", () => {
    const { result } = run(
      [healthy(BAMBOOHR_ID, LISTED_BAMBOOHR_POSTINGS)],
      firstRun,
    );

    expect(result.recommended).toEqual([]);
    expect(result.watching).toEqual([]);
    expect(result.unreconciled).toEqual([
      {
        sourceId: LEVER_ID,
        status: "unchecked",
        detail: "the run read no listing for the source",
        coveredRows: 2,
      },
    ]);
  });

  it("never recommends a posting an unhealthy source has missed repeatedly", () => {
    run(listing, firstRun);
    run([failed(LEVER_ID)], secondRun);
    const { result } = run([failed(LEVER_ID)], thirdRun);

    expect(result.recommended).toEqual([]);
  });

  it("reports nothing about a board row no adapter covers", () => {
    const everySourceHealthy = [
      healthy(LEVER_ID, LISTED_LEVER_POSTINGS),
      healthy(BAMBOOHR_ID, LISTED_BAMBOOHR_POSTINGS),
    ];
    const { result, target } = run(everySourceHealthy, firstRun);

    expect(result.coveredRows).toBe(2);
    expect(result.uncoveredRows).toBe(1);
    expect(Object.keys(result.state.missing)).toEqual([withdrawnKey]);
    expect(readFileSync(target, "utf-8")).not.toContain(uncoveredRow.applyLink);
  });

  it("treats a posting a healthy BambooHR listing carries as still listed", () => {
    const bambooBoard = boardOf([
      boardRow(4, bambooHrLink(LISTED_BAMBOOHR_ID)),
    ]);
    const { result } = reconcileToDisk(
      bambooBoard,
      [healthy(BAMBOOHR_ID, LISTED_BAMBOOHR_POSTINGS)],
      firstRun,
      root,
    );

    expect(result.coveredRows).toBe(1);
    expect(result.state.missing).toEqual({});
  });

  it("runs without a state file and against a malformed one", () => {
    const first = run(listing, firstRun);
    expect(first.result.watching).toHaveLength(1);

    writeFileSync(
      join(root, "scripts", "data", "sources-state.json"),
      '{"postings": "not a map", "missing": 7',
      "utf-8",
    );

    const second = run(listing, secondRun);
    // A damaged file loses the count, so the posting is watched again rather
    // than recommended on evidence the file no longer holds.
    expect(second.result.recommended).toEqual([]);
    expect(second.result.watching).toHaveLength(1);
  });

  it("keeps a state file written before the missing map was recorded", () => {
    writeFileSync(
      join(root, "scripts", "data", "sources-state.json"),
      JSON.stringify({
        postings: {
          [withdrawnKey]: {
            lastSeen: firstRun.toISOString(),
            title: withdrawnRow.title,
            url: withdrawnRow.applyLink,
            decided: true,
          },
        },
      }),
      "utf-8",
    );

    const { result } = run(listing, secondRun);

    expect(result.state.postings[withdrawnKey].decided).toBe(true);
    expect(result.state.missing[withdrawnKey].misses).toBe(1);
  });
});

describe("the files reconciliation may not write", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reconcile-guard-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["jobboard.json", "slt-jobs.csv", join("..", "jobboard.json")])(
    "refuses to write %s",
    (target) => {
      expect(() => writeAllowedFile(target, "[]", root)).toThrow(
        WriteOutsideAllowlistError,
      );
    },
  );

  it("leaves the board data untouched across a run that recommends a removal", () => {
    for (const name of ["jobboard.json", "slt-jobs.csv"]) {
      copyFileSync(resolve(REPOSITORY_ROOT, name), join(root, name));
    }
    const before = ["jobboard.json", "slt-jobs.csv"].map((name) =>
      readFileSync(join(root, name)),
    );

    const board = readBoardRows(root);
    const listing = [healthy(LEVER_ID, [])];
    reconcileToDisk(board, listing, new Date("2026-03-01T12:00:00.000Z"), root);
    const { result } = reconcileToDisk(
      board,
      listing,
      new Date("2026-03-02T12:00:00.000Z"),
      root,
    );

    expect(result.recommended.length).toBeGreaterThan(0);
    const after = ["jobboard.json", "slt-jobs.csv"].map((name) =>
      readFileSync(join(root, name)),
    );
    expect(after).toEqual(before);
  });

  it("writes the report somewhere of its own, not over the new postings file", () => {
    expect(RECONCILE_REPORT_PATH).not.toBe(join("review", "new-jobs.csv"));
  });
});
