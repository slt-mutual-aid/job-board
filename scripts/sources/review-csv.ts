import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

// scripts/sources/review-csv.ts sits two directories below the repository root.
export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// The only directories the source tooling may write. slt-jobs.csv and
// jobboard.json sit outside both, which is what stops a bug in an adapter from
// reaching the files the live board is built from.
const WRITABLE_DIRECTORIES = ["review", join("scripts", "data")];

export const REVIEW_CSV_PATH = join("review", "new-jobs.csv");

export class WriteOutsideAllowlistError extends Error {
  constructor(target: string) {
    super(
      `Refusing to write ${target}: only ${WRITABLE_DIRECTORIES.join(" and ")} accept writes`,
    );
    this.name = "WriteOutsideAllowlistError";
  }
}

function isInside(directory: string, target: string): boolean {
  const step = relative(directory, target);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

// The single write path of the source tooling. A target outside the allowlist
// throws instead of being written, so no caller can name slt-jobs.csv or
// jobboard.json however the path is spelled.
export function writeAllowedFile(
  targetPath: string,
  contents: string,
  root: string = REPOSITORY_ROOT,
): string {
  const target = resolve(root, targetPath);
  const allowed = WRITABLE_DIRECTORIES.some((directory) =>
    isInside(resolve(root, directory), target),
  );
  if (!allowed) {
    throw new WriteOutsideAllowlistError(targetPath);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf-8");
  return target;
}

export interface ReviewJob {
  // A field the source does not publish stays undefined and reaches the file
  // empty. The importer already reads an empty Date Posted as an unknown date,
  // and a guessed hourly rate costs a job seeker money and trust.
  datePosted?: string;
  company: string;
  title: string;
  applicationLink?: string;
  typeOfWork?: string;
  hourlyRate?: string;
  location?: string;
  description?: string;
  closesBy?: string;
  // The registry source id, which names one employer's listing.
  sourceId: string;
  // The key the state file records the reviewer's decision against.
  postingKey: string;
}

// The column the reviewer types into.
export const DECISION_HEADER = "Decision";

// Names the listing a row was read from, which is what tells one employer's
// rows from another's when the file carries every source at once.
export const SOURCE_HEADER = "Source";

// Ties a row back to the posting key the state file records.
export const POSTING_KEY_HEADER = "Posting Key";

// The first nine entries are the columns of slt-jobs.csv in the order the
// importer reads them by position. Approving a row is then a matter of dropping
// the review-only columns that follow, with no field moved.
const COLUMNS: ReadonlyArray<{
  header: string;
  value: (job: ReviewJob) => string;
}> = [
  { header: "Date Posted", value: (job) => job.datePosted ?? "" },
  { header: "Company", value: (job) => job.company },
  { header: "Job Title", value: (job) => job.title },
  { header: "Application Link", value: (job) => job.applicationLink ?? "" },
  { header: "Type of work", value: (job) => job.typeOfWork ?? "" },
  { header: "Hourly Rate", value: (job) => job.hourlyRate ?? "" },
  { header: "Location", value: (job) => job.location ?? "" },
  { header: "Description", value: (job) => job.description ?? "" },
  { header: "Job Closes by", value: (job) => job.closesBy ?? "" },
  { header: DECISION_HEADER, value: () => "" },
  { header: SOURCE_HEADER, value: (job) => job.sourceId },
  { header: POSTING_KEY_HEADER, value: (job) => job.postingKey },
  { header: "Notes", value: () => "" },
];

export const BOARD_COLUMN_COUNT = 9;

export const REVIEW_COLUMN_HEADERS: readonly string[] = COLUMNS.map(
  (column) => column.header,
);

// One row of the review file, keyed by header. A row a run carries over from
// the previous file arrives in this shape rather than as a ReviewJob, because
// the source it came from is the source this run could not read.
export type ReviewRow = Record<string, string>;

export function toReviewRow(job: ReviewJob): ReviewRow {
  const row: ReviewRow = {};
  for (const column of COLUMNS) {
    row[column.header] = column.value(job);
  }
  return row;
}

export function formatReviewCsv(rows: readonly ReviewRow[]): string {
  const records = [
    COLUMNS.map((column) => column.header),
    ...rows.map((row) => COLUMNS.map((column) => row[column.header] ?? "")),
  ];

  const text = stringify(records, {
    record_delimiter: "\r\n",
    // csv-stringify quotes a value holding the whole record delimiter and
    // leaves a lone LF or CR bare. A job description carries lone newlines, and
    // an unquoted one splits that job across two rows.
    quoted_match: /[\r\n]/,
  });

  // slt-jobs.csv ends its last record without a delimiter, so a paste of the
  // whole file adds no blank row.
  return text.replace(/\r\n$/, "");
}

// Every run rewrites the same file. A dated filename would accumulate forever
// in a repository that deploys from main, and git history already dates a run.
export function writeReviewCsv(
  rows: readonly ReviewRow[],
  root?: string,
): string {
  return writeAllowedFile(REVIEW_CSV_PATH, formatReviewCsv(rows), root);
}

// The review file is rewritten on every run, so what it already carries is
// read back before the rewrite: the decisions a reviewer typed, and the rows of
// a source this run could not read. A file that cannot be parsed throws, which
// stops the run before the rewrite that would discard both.
export function readReviewRows(root: string = REPOSITORY_ROOT): ReviewRow[] {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, REVIEW_CSV_PATH), "utf-8");
  } catch {
    return [];
  }

  return parse(raw, {
    columns: true,
    // A spreadsheet saving the file back ends its rows with whichever newline
    // the program on the reviewer's machine prefers.
    record_delimiter: ["\r\n", "\n", "\r"],
    skip_empty_lines: true,
  }) as ReviewRow[];
}

export function cellOf(row: ReviewRow, header: string): string {
  return (row[header] ?? "").trim();
}

// A row the reviewer left blank is a posting still awaiting a decision, and it
// stays in the queue.
export function decidedKeys(rows: readonly ReviewRow[]): string[] {
  return rows
    .filter((row) => cellOf(row, DECISION_HEADER) !== "")
    .map((row) => cellOf(row, POSTING_KEY_HEADER))
    .filter((key) => key !== "");
}
