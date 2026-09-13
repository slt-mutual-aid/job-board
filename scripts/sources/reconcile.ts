import { readFileSync } from "fs";
import { join, resolve } from "path";
import type { Job } from "../../src/lib/db";
import type { SourceAssessment } from "./health";
import { boardLinkPostingId } from "./adapters/icims";
import {
  bambooHrSource,
  icimsDavidsonSource,
  icimsOvgSource,
  leverSource,
  oracleCaesarsSource,
  oracleRaleysSource,
} from "./registry";
import { REPOSITORY_ROOT, writeAllowedFile } from "./review-csv";
import {
  loadSourcesState,
  postingKey,
  saveSourcesState,
  type MissingRecord,
  type SourcesState,
} from "./state";
import type { OracleConfig } from "./adapters/oracle";
import type { IdentifiedEntry } from "./types";

// review/new-jobs.csv is rewritten on every source run and carries postings a
// reviewer may add, so the postings a reviewer may remove get their own path.
export const RECONCILE_REPORT_PATH = join("review", "missing-jobs.md");

// One healthy listing without the posting is also what a republished posting, a
// renumbered identifier, or a location field the employer edited looks like.
// Two consecutive healthy listings is the employer saying it twice.
export const MISSES_BEFORE_REMOVAL = 2;

// Read, never written. jobboard.json sits outside the allowlist of
// review-csv.ts, which is what keeps the write path incapable of reaching it.
const BOARD_FILE = "jobboard.json";

export interface BoardRow {
  id: number;
  company: string;
  title: string;
  applyLink: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A row with no apply link carries nothing to match against a listing, so it
// never reaches the matcher and counts as a row no adapter covers.
export function toBoardRow(value: unknown): BoardRow | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const { id, company, title, apply_link: applyLink } = value as Partial<Job>;
  if (
    typeof id !== "number" ||
    typeof company !== "string" ||
    typeof title !== "string" ||
    typeof applyLink !== "string" ||
    applyLink === ""
  ) {
    return undefined;
  }

  return { id, company, title, applyLink };
}

export interface BoardRows {
  rows: BoardRow[];
  // Every row the file carried, so a summary can report how much of the board
  // the matcher speaks for rather than how much of the matchable part.
  total: number;
}

export function readBoardRows(root: string = REPOSITORY_ROOT): BoardRows {
  const decoded: unknown = JSON.parse(
    readFileSync(resolve(root, BOARD_FILE), "utf-8"),
  );
  if (!Array.isArray(decoded)) {
    throw new Error(`${BOARD_FILE} is not an array of jobs`);
  }

  const rows: BoardRow[] = [];
  for (const value of decoded) {
    const row = toBoardRow(value);
    if (row !== undefined) {
      rows.push(row);
    }
  }

  return { rows, total: decoded.length };
}

function pathSegments(link: URL): string[] {
  return link.pathname.split("/").filter((segment) => segment !== "");
}

// Lever writes a posting page as /<company>/<posting id>. Matching the account
// as well as the host keeps a posting from another Lever customer out.
function leverPostingId(link: URL): string | null {
  if (link.hostname !== "jobs.lever.co") {
    return null;
  }

  const segments = pathSegments(link);
  if (segments.length !== 2 || segments[0] !== leverSource.config.company) {
    return null;
  }

  return segments[1];
}

// BambooHR writes a posting page as /careers/<posting id> on the account's own
// host, and the identifier the listing hands out is a number.
function bambooHrPostingId(link: URL): string | null {
  if (link.hostname !== `${bambooHrSource.config.subdomain}.bamboohr.com`) {
    return null;
  }

  const segments = pathSegments(link);
  if (segments.length !== 2 || segments[0] !== "careers") {
    return null;
  }

  return /^\d+$/.test(segments[1]) ? segments[1] : null;
}

// Oracle writes a posting page as /hcmUI/CandidateExperience/<locale>/sites/
// <site>/job/<posting id>, and the board also carries the /jobs/preview/<posting
// id> form the career site hands out from a search result. Each employer has a
// host of its own, so the host is what keeps the two Oracle accounts apart.
function oraclePostingId(link: URL, config: OracleConfig): string | null {
  if (link.hostname !== config.host) {
    return null;
  }

  const segments = pathSegments(link);
  const site = segments.indexOf("sites");
  if (site === -1 || segments[site + 1] !== config.siteNumber) {
    return null;
  }

  const tail = segments.slice(site + 2);
  const id =
    tail.length === 2 && tail[0] === "job"
      ? tail[1]
      : tail.length === 3 && tail[0] === "jobs" && tail[1] === "preview"
        ? tail[2]
        : null;

  return id !== null && /^\d+$/.test(id) ? id : null;
}

interface CoveredSource {
  // The identifier a health assessment carries for the source, which names one
  // employer's listing rather than the adapter that reads it.
  sourceId: string;
  // The namespace the posting key is recorded under.
  accountId: string;
  postingIdFor(link: URL): string | null;
}

// Each source recognizes its own links. A generic rule that dropped query
// parameters and compared what was left would claim postings on platforms no
// adapter reads, and every one of those claims would be a guess.
const COVERED_SOURCES: readonly CoveredSource[] = [
  {
    sourceId: leverSource.sourceId,
    accountId: leverSource.accountId,
    postingIdFor: leverPostingId,
  },
  {
    sourceId: bambooHrSource.sourceId,
    accountId: bambooHrSource.accountId,
    postingIdFor: bambooHrPostingId,
  },
  {
    sourceId: icimsOvgSource.sourceId,
    accountId: icimsOvgSource.accountId,
    postingIdFor: (link) => boardLinkPostingId(icimsOvgSource.config, link),
  },
  {
    sourceId: icimsDavidsonSource.sourceId,
    accountId: icimsDavidsonSource.accountId,
    postingIdFor: (link) =>
      boardLinkPostingId(icimsDavidsonSource.config, link),
  },
  {
    sourceId: oracleCaesarsSource.sourceId,
    accountId: oracleCaesarsSource.accountId,
    postingIdFor: (link) => oraclePostingId(link, oracleCaesarsSource.config),
  },
  {
    sourceId: oracleRaleysSource.sourceId,
    accountId: oracleRaleysSource.accountId,
    postingIdFor: (link) => oraclePostingId(link, oracleRaleysSource.config),
  },
];

// Held to the registry by a coverage test, so a source added later cannot leave
// its board rows unreconciled while the report still reads as complete.
export const COVERED_SOURCE_IDS: readonly string[] = COVERED_SOURCES.map(
  (source) => source.sourceId,
);

export interface BoardMatch {
  sourceId: string;
  postingId: string;
  key: string;
}

// Null for every row whose link no adapter reads, which is most of the board.
export function matchBoardRow(row: BoardRow): BoardMatch | null {
  let link: URL;
  try {
    link = new URL(row.applyLink);
  } catch {
    return null;
  }

  for (const source of COVERED_SOURCES) {
    const postingId = source.postingIdFor(link);
    if (postingId !== null) {
      return {
        sourceId: source.sourceId,
        postingId,
        key: postingKey(source.accountId, postingId),
      };
    }
  }

  return null;
}

export interface MissingPosting {
  row: BoardRow;
  sourceId: string;
  key: string;
  record: MissingRecord;
  // States what the listing showed, so a person can confirm the posting is gone
  // before removing the row.
  reason: string;
}

// A source that found nothing it can vouch for still reports what it found. It
// simply says nothing about whether a board row has disappeared.
export interface UnreconciledSource {
  sourceId: string;
  status: string;
  detail: string;
  coveredRows: number;
}

export interface ReconcileInput {
  board: BoardRows;
  assessments: readonly SourceAssessment<IdentifiedEntry>[];
  state: SourcesState;
  now: Date;
}

export interface ReconcileResult {
  state: SourcesState;
  recommended: MissingPosting[];
  watching: MissingPosting[];
  coveredRows: number;
  uncoveredRows: number;
  unreconciled: UnreconciledSource[];
}

function describeMisses(record: MissingRecord, sourceId: string): string {
  const runs =
    record.misses === 1
      ? "1 healthy run"
      : `${record.misses} consecutive healthy runs`;
  return `absent from the ${sourceId} listing on ${runs}, first on ${record.firstMissedAt}`;
}

// Only a healthy assessment carries postings, so a source the health rules
// refused cannot reach the listing membership test at all, whatever it found.
function listedIdsBySource(
  assessments: readonly SourceAssessment<IdentifiedEntry>[],
): Map<string, Set<string>> {
  const listed = new Map<string, Set<string>>();
  for (const assessment of assessments) {
    if (assessment.status === "healthy") {
      listed.set(
        assessment.sourceId,
        new Set(assessment.postings.map((posting) => posting.id)),
      );
    }
  }
  return listed;
}

// The missing map is rebuilt from the board on every run, so a row a person has
// already removed takes its watch with it.
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { board, assessments, state, now } = input;
  const listed = listedIdsBySource(assessments);
  const timestamp = now.toISOString();

  const missing: Record<string, MissingRecord> = {};
  const recommended: MissingPosting[] = [];
  const watching: MissingPosting[] = [];
  const coveredBySource = new Map<string, number>();
  let coveredRows = 0;

  for (const row of board.rows) {
    const match = matchBoardRow(row);
    if (match === null) {
      continue;
    }

    coveredRows += 1;
    coveredBySource.set(
      match.sourceId,
      (coveredBySource.get(match.sourceId) ?? 0) + 1,
    );

    const listing = listed.get(match.sourceId);
    if (listing === undefined) {
      // The run learned nothing about the posting, so the watch it already
      // carries is neither advanced nor cleared.
      const held = state.missing[match.key];
      if (held !== undefined) {
        missing[match.key] = held;
      }
      continue;
    }

    if (listing.has(match.postingId)) {
      continue;
    }

    const held = state.missing[match.key];
    const record: MissingRecord = {
      misses: (held?.misses ?? 0) + 1,
      firstMissedAt: held?.firstMissedAt ?? timestamp,
      lastMissedAt: timestamp,
    };
    missing[match.key] = record;

    const posting: MissingPosting = {
      row,
      sourceId: match.sourceId,
      key: match.key,
      record,
      reason: describeMisses(record, match.sourceId),
    };
    if (record.misses >= MISSES_BEFORE_REMOVAL) {
      recommended.push(posting);
    } else {
      watching.push(posting);
    }
  }

  // Walked from the board rather than from the assessments, so a source the run
  // never read is reported rather than passing as a source with nothing to say.
  const assessed = new Map(
    assessments.map((assessment) => [assessment.sourceId, assessment]),
  );
  const unreconciled: UnreconciledSource[] = [];
  for (const [sourceId, rows] of coveredBySource) {
    const assessment = assessed.get(sourceId);
    if (assessment === undefined) {
      unreconciled.push({
        sourceId,
        status: "unchecked",
        detail: "the run read no listing for the source",
        coveredRows: rows,
      });
    } else if (assessment.status !== "healthy") {
      unreconciled.push({
        sourceId,
        status: assessment.status,
        detail: assessment.detail,
        coveredRows: rows,
      });
    }
  }

  return {
    state: { ...state, missing },
    recommended,
    watching,
    coveredRows,
    uncoveredRows: board.total - coveredRows,
    unreconciled,
  };
}

function postingLines(posting: MissingPosting): string {
  const { row } = posting;
  return [
    `- ${row.company}: ${row.title} (board row ${row.id})`,
    `  - Link: ${row.applyLink}`,
    `  - Reason: ${posting.reason}`,
  ].join("\n");
}

function section(title: string, postings: readonly MissingPosting[]): string {
  if (postings.length === 0) {
    return `## ${title}\n\nNone.`;
  }
  return `## ${title}\n\n${postings.map(postingLines).join("\n")}`;
}

export function formatReconcileReport(
  result: ReconcileResult,
  now: Date,
): string {
  const parts = [
    "# Board rows missing from their employer's listing",
    `Run at ${now.toISOString()}. Nothing on the board is removed by this report. A person confirms each posting and removes the row from the spreadsheet.`,
    section(
      `Recommended for removal (${result.recommended.length})`,
      result.recommended,
    ),
    section(
      `Watching, one healthy run short of a recommendation (${result.watching.length})`,
      result.watching,
    ),
    [
      "## Coverage",
      "",
      `${result.coveredRows} of ${result.coveredRows + result.uncoveredRows} board rows carry a link one of the adapters reads. The other ${result.uncoveredRows} come from sources with no adapter, and this report says nothing about them.`,
    ].join("\n"),
  ];

  if (result.unreconciled.length > 0) {
    const lines = result.unreconciled.map(
      (source) =>
        `- ${source.sourceId}: ${source.status} (${source.detail}). Its ${source.coveredRows} board row(s) kept whatever they carried before this run.`,
    );
    parts.push(
      [
        "## Sources that produced no conclusions",
        "",
        "A listing the health rules refused says nothing about whether a posting is gone.",
        "",
        ...lines,
      ].join("\n"),
    );
  }

  return `${parts.join("\n\n")}\n`;
}

// The disk half of a run. The listings arrive already assessed, so a test can
// drive the whole path from recorded fixtures without a request.
export function reconcileToDisk(
  board: BoardRows,
  assessments: readonly SourceAssessment<IdentifiedEntry>[],
  now: Date,
  root?: string,
): { result: ReconcileResult; target: string } {
  const result = reconcile({
    board,
    assessments,
    state: loadSourcesState(root),
    now,
  });

  // Saved before the report, because a report written against a run the state
  // file never recorded repeats the same first miss on the next run.
  saveSourcesState(result.state, root);

  return { result, target: writeReconcileReport(result, now, root) };
}

export function writeReconcileReport(
  result: ReconcileResult,
  now: Date,
  root?: string,
): string {
  return writeAllowedFile(
    RECONCILE_REPORT_PATH,
    formatReconcileReport(result, now),
    root,
  );
}
