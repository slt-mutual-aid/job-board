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
  sourceId: string;
}

// The column the reviewer types into, and the column that ties a row back to
// the posting key the state file records.
export const DECISION_HEADER = "Decision";
export const SOURCE_ID_HEADER = "Source ID";

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
  { header: SOURCE_ID_HEADER, value: (job) => job.sourceId },
  { header: "Notes", value: () => "" },
];

export const BOARD_COLUMN_COUNT = 9;

export const REVIEW_COLUMN_HEADERS: readonly string[] = COLUMNS.map(
  (column) => column.header,
);

export function formatReviewCsv(jobs: readonly ReviewJob[]): string {
  const rows = [
    COLUMNS.map((column) => column.header),
    ...jobs.map((job) => COLUMNS.map((column) => column.value(job))),
  ];

  const text = stringify(rows, {
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
  jobs: readonly ReviewJob[],
  root?: string,
): string {
  return writeAllowedFile(REVIEW_CSV_PATH, formatReviewCsv(jobs), root);
}

// The review file is rewritten on every run, so the decisions it carries are
// read out of it first and kept in the state file. A row the reviewer left
// blank is a posting still awaiting a decision, and it stays in the queue.
// A file that cannot be parsed throws, which stops the run before the rewrite
// that would discard the decisions inside it.
export function readReviewDecisions(root: string = REPOSITORY_ROOT): string[] {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, REVIEW_CSV_PATH), "utf-8");
  } catch {
    return [];
  }

  const rows = parse(raw, {
    columns: true,
    // The spreadsheet ends a row at any newline, and a description carries
    // lone newlines inside its quotes.
    record_delimiter: ["\r\n", "\n", "\r"],
    skip_empty_lines: true,
  }) as Array<Record<string, string>>;

  return rows
    .filter((row) => (row[DECISION_HEADER] ?? "").trim() !== "")
    .map((row) => (row[SOURCE_ID_HEADER] ?? "").trim())
    .filter((sourceId) => sourceId !== "");
}
