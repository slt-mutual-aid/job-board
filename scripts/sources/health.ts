import { readFileSync } from "fs";
import { join, resolve } from "path";
import { REPOSITORY_ROOT, writeAllowedFile } from "./review-csv";

// scripts/data already sits inside the write allowlist, so the health file
// reaches disk through the same guard that keeps slt-jobs.csv and jobboard.json
// out of reach of the source tooling.
export const HEALTH_FILE_PATH = join("scripts", "data", "source-health.json");

// Falling below half the previous count is the drop the guard in
// .github/workflows/update-jobs.yml already fails a run over, applied here to
// one source at a time rather than to the whole board.
const DROP_DIVISOR = 2;

// Under four postings an ordinary single closure already crosses the half mark,
// and a guard that reports a normal week is a guard nobody reads.
const MIN_PREVIOUS_COUNT_FOR_DROP = 4;

// Enough runs to show a trend to a person reading the file, few enough that the
// file stays readable in a diff.
const HISTORY_LIMIT = 10;

export type SourceHealthStatus =
  | "healthy"
  | "error"
  | "suspicious-zero"
  | "suspicious-drop";

// A run that reached a count.
export interface SourceReading {
  kind: "reading";
  sourceId: string;
  // Postings at the configured location, after the adapter's location filter.
  postingCount: number;
  // Entries the response carried before that filter. A response that carried
  // entries was read, whatever the location filter then left.
  entryCount: number;
  // The adapter's own report that the response was well formed and genuinely
  // held nothing, which is the only thing that separates an empty feed from a
  // parser that lost every posting.
  confirmedEmpty: boolean;
}

// A run that threw or never completed its request. A failure carries no count,
// so nothing downstream can read it as a day with no postings.
export interface SourceFailure {
  kind: "failure";
  sourceId: string;
  message: string;
}

export type SourceObservation = SourceReading | SourceFailure;

export function observedFailure(
  sourceId: string,
  error: unknown,
): SourceFailure {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { kind: "failure", sourceId, message };
}

export interface SourceAssessment {
  sourceId: string;
  status: SourceHealthStatus;
  // Null for a failure, where no count was ever read. A failed request and a
  // source with no postings are different facts, and a number here for both
  // would be the conflation this module exists to prevent.
  postingCount: number | null;
  previousCount: number | null;
  detail: string;
}

export interface SourceHistoryEntry {
  at: string;
  count: number;
}

export interface SourceHealthRecord {
  lastRunAt: string;
  // The last run that produced a count at all. A run that threw leaves the
  // value where it was, which is what makes a long-broken source visible.
  lastSuccessfulRunAt: string | null;
  history: SourceHistoryEntry[];
}

export interface SourceHealthFile {
  sources: Record<string, SourceHealthRecord>;
}

// Only a healthy source may have its absent postings read as withdrawals. An
// adapter whose employer redesigned their site reports nothing found, and
// nothing found must never be allowed to retire a posting that is still open.
export function allowsRemovalConclusions(
  assessment: SourceAssessment,
): boolean {
  return assessment.status === "healthy";
}

// A drop still reports postings a reviewer can act on, so it does not stop the
// run. An error or a vanished source produces an empty result that otherwise
// reads exactly like a quiet day, which is the failure worth halting for.
export function exitCodeFor(assessments: readonly SourceAssessment[]): number {
  const halting = assessments.some(
    (assessment) =>
      assessment.status === "error" || assessment.status === "suspicious-zero",
  );
  return halting ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toHistoryEntry(value: unknown): SourceHistoryEntry | null {
  if (!isObject(value)) {
    return null;
  }
  const { at, count } = value;
  if (typeof at !== "string" || typeof count !== "number") {
    return null;
  }
  return { at, count };
}

function toRecord(value: unknown): SourceHealthRecord | null {
  if (!isObject(value) || !Array.isArray(value.history)) {
    return null;
  }
  const history: SourceHistoryEntry[] = [];
  for (const raw of value.history) {
    const entry = toHistoryEntry(raw);
    if (entry === null) {
      return null;
    }
    history.push(entry);
  }
  if (typeof value.lastRunAt !== "string") {
    return null;
  }
  const lastSuccessfulRunAt = value.lastSuccessfulRunAt;
  if (lastSuccessfulRunAt !== null && typeof lastSuccessfulRunAt !== "string") {
    return null;
  }
  return { lastRunAt: value.lastRunAt, lastSuccessfulRunAt, history };
}

// A file that cannot be read is treated as a first run rather than as an error.
// Refusing to run without history would take the guard offline exactly when the
// file is being introduced or has been damaged.
export function readHealthFile(
  root: string = REPOSITORY_ROOT,
): SourceHealthFile {
  let text: string;
  try {
    text = readFileSync(resolve(root, HEALTH_FILE_PATH), "utf-8");
  } catch {
    return { sources: {} };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { sources: {} };
  }

  if (!isObject(decoded) || !isObject(decoded.sources)) {
    return { sources: {} };
  }

  const sources: Record<string, SourceHealthRecord> = {};
  for (const [sourceId, raw] of Object.entries(decoded.sources)) {
    const record = toRecord(raw);
    if (record !== null) {
      sources[sourceId] = record;
    }
  }
  return { sources };
}

export function previousCountOf(
  file: SourceHealthFile,
  sourceId: string,
): number | null {
  const history = file.sources[sourceId]?.history ?? [];
  const last = history[history.length - 1];
  return last === undefined ? null : last.count;
}

// The rules are ordered by precedence. A failure never reaches the zero rules,
// and an unconfirmed zero never reaches the comparison against history, because
// neither carries a count anybody should compare.
export function assess(
  observation: SourceObservation,
  previousCount: number | null,
): SourceAssessment {
  const { sourceId } = observation;

  if (observation.kind === "failure") {
    return {
      sourceId,
      status: "error",
      postingCount: null,
      previousCount,
      detail: observation.message,
    };
  }

  const { postingCount, entryCount, confirmedEmpty } = observation;
  const base = { sourceId, postingCount, previousCount };

  // A response that carried entries accounted for itself, even where every
  // entry sits in another town. Only a response that produced neither entries
  // nor a confirmation of emptiness is a parse that lost its postings.
  if (entryCount === 0 && !confirmedEmpty) {
    return {
      ...base,
      status: "error",
      detail: "no entries and no confirmation that the response was empty",
    };
  }

  if (postingCount === 0 && previousCount !== null && previousCount > 0) {
    return {
      ...base,
      status: "suspicious-zero",
      detail: `no postings, down from ${previousCount} on the previous run`,
    };
  }

  if (
    previousCount !== null &&
    previousCount >= MIN_PREVIOUS_COUNT_FOR_DROP &&
    postingCount * DROP_DIVISOR < previousCount
  ) {
    return {
      ...base,
      status: "suspicious-drop",
      detail: `${postingCount} postings, down from ${previousCount} on the previous run`,
    };
  }

  return {
    ...base,
    status: "healthy",
    detail:
      previousCount === null
        ? `${postingCount} postings, no previous run on record`
        : `${postingCount} postings, ${previousCount} on the previous run`,
  };
}

function updatedRecord(
  existing: SourceHealthRecord | undefined,
  assessment: SourceAssessment,
  now: Date,
): SourceHealthRecord {
  const at = now.toISOString();
  const history = existing?.history ?? [];

  // An error appends no count. A count the run itself calls unreliable would
  // become the baseline the next run compares against, and a source that stayed
  // broken would read as a quiet one from then on.
  if (assessment.status === "error" || assessment.postingCount === null) {
    return {
      lastRunAt: at,
      lastSuccessfulRunAt: existing?.lastSuccessfulRunAt ?? null,
      history,
    };
  }

  return {
    lastRunAt: at,
    lastSuccessfulRunAt: at,
    history: [...history, { at, count: assessment.postingCount }].slice(
      -HISTORY_LIMIT,
    ),
  };
}

export interface RunRecordOptions {
  now: Date;
  root?: string;
}

// Assesses every observation against the history on disk, then writes the run
// back. The assessments are returned in the order the observations arrived, so
// a summary can list every configured source rather than only the eventful ones.
export function recordRun(
  observations: readonly SourceObservation[],
  options: RunRecordOptions,
): SourceAssessment[] {
  const root = options.root ?? REPOSITORY_ROOT;
  const file = readHealthFile(root);

  const assessments = observations.map((observation) =>
    assess(observation, previousCountOf(file, observation.sourceId)),
  );

  const sources = { ...file.sources };
  for (const assessment of assessments) {
    sources[assessment.sourceId] = updatedRecord(
      sources[assessment.sourceId],
      assessment,
      options.now,
    );
  }

  writeAllowedFile(
    HEALTH_FILE_PATH,
    `${JSON.stringify({ sources }, null, 2)}\n`,
    root,
  );

  return assessments;
}

const COLUMNS: Array<{
  header: string;
  value: (assessment: SourceAssessment) => string;
}> = [
  { header: "SOURCE", value: (assessment) => assessment.sourceId },
  { header: "STATUS", value: (assessment) => assessment.status },
  {
    header: "FOUND",
    value: (assessment) =>
      assessment.postingCount === null ? "-" : String(assessment.postingCount),
  },
  { header: "DETAIL", value: (assessment) => assessment.detail },
];

// Every source gets a line, including a source that found nothing. A source
// that silently stops appearing in the summary is the failure this module
// exists to catch, so absence is never left to the reader to notice.
export function formatRunSummary(
  assessments: readonly SourceAssessment[],
): string {
  const rows = [
    COLUMNS.map((column) => column.header),
    ...assessments.map((assessment) =>
      COLUMNS.map((column) => column.value(assessment)),
    ),
  ];
  const widths = COLUMNS.map((_, index) =>
    Math.max(...rows.map((row) => row[index].length)),
  );

  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
