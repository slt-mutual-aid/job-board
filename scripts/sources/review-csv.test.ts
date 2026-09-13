import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseCsv } from "csv-parse/sync";
import {
  BOARD_COLUMN_COUNT,
  REVIEW_COLUMN_HEADERS,
  REVIEW_CSV_PATH,
  WriteOutsideAllowlistError,
  formatReviewCsv,
  toReviewRow,
  writeAllowedFile,
  writeReviewCsv,
  type ReviewJob,
} from "./review-csv";
import { leverSource } from "./registry";
import { toReviewJob } from "./review";

// The nine columns of slt-jobs.csv, which carries no header row and is read by
// position. A reordering here is a silent field remap in the spreadsheet.
const BOARD_COLUMNS = [
  "Date Posted",
  "Company",
  "Job Title",
  "Application Link",
  "Type of work",
  "Hourly Rate",
  "Location",
  "Description",
  "Job Closes by",
];

const LISTING_FIXTURE = readFileSync(
  new URL("./__fixtures__/lever-insomnia/listing.json", import.meta.url),
  "utf-8",
);

// The spreadsheet ends a row at any newline, so an unquoted one splits a job in
// two. csv-parse picks a single record delimiter and would read a lone newline
// as ordinary text, hiding exactly that break.
function readAsSpreadsheetWould(text: string): string[][] {
  return parseCsv(text, {
    record_delimiter: ["\r\n", "\n", "\r"],
  }) as string[][];
}

function listFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

const job: ReviewJob = {
  datePosted: "7/11/2026",
  company: "Insomnia Cookies",
  title: "Cookie Crew",
  applicationLink: "https://jobs.lever.co/insomniacookies/abc",
  typeOfWork: "Part-time",
  location: "South Lake Tahoe CA",
  description: "Bake cookies.",
  sourceId: "lever",
  postingKey: "lever:insomniacookies:abc",
  fit: "likely",
  fitReason: 'The employment type says "Part-time".',
};

function csvOf(jobs: readonly ReviewJob[]): string {
  return formatReviewCsv(jobs.map(toReviewRow));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-csv-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the review file layout", () => {
  it("opens with the nine board columns in the order the importer reads", () => {
    expect(REVIEW_COLUMN_HEADERS.slice(0, BOARD_COLUMN_COUNT)).toEqual(
      BOARD_COLUMNS,
    );
  });

  it("puts the review-only columns after the nine board columns", () => {
    expect(REVIEW_COLUMN_HEADERS.slice(BOARD_COLUMN_COUNT)).toEqual([
      "Decision",
      "Fit",
      "Fit Reason",
      "Source",
      "Posting Key",
      "Notes",
    ]);
  });

  it("leaves the nine board columns the same whatever the verdict says", () => {
    const [, likely] = readAsSpreadsheetWould(
      csvOf([
        { ...job, fit: "likely", fitReason: 'The title says "part time".' },
      ]),
    );
    const [, unlikely] = readAsSpreadsheetWould(
      csvOf([
        {
          ...job,
          fit: "unlikely",
          fitReason: "The title names a manager role.",
        },
      ]),
    );

    expect(likely.slice(0, BOARD_COLUMN_COUNT)).toEqual(
      unlikely.slice(0, BOARD_COLUMN_COUNT),
    );
    expect(likely[REVIEW_COLUMN_HEADERS.indexOf("Fit")]).toBe("likely");
    expect(unlikely[REVIEW_COLUMN_HEADERS.indexOf("Fit")]).toBe("unlikely");
  });

  it("leaves the decision and notes columns empty for the reviewer", () => {
    const [, row] = parseCsv(csvOf([job])) as string[][];
    expect(row[REVIEW_COLUMN_HEADERS.indexOf("Decision")]).toBe("");
    expect(row[REVIEW_COLUMN_HEADERS.indexOf("Notes")]).toBe("");
  });

  it("names the listing each row came from", () => {
    const [, row] = parseCsv(csvOf([job])) as string[][];
    expect(row[REVIEW_COLUMN_HEADERS.indexOf("Source")]).toBe("lever");
    expect(row[REVIEW_COLUMN_HEADERS.indexOf("Company")]).toBe(
      "Insomnia Cookies",
    );
  });

  it("leaves a field the source does not publish empty", () => {
    const [, row] = parseCsv(
      csvOf([
        {
          company: "A Bakery",
          title: "Baker",
          sourceId: "x",
          postingKey: "x:1",
          fit: "unknown",
          fitReason: "Nothing here decides it.",
        },
      ]),
    ) as string[][];
    expect(row.slice(0, BOARD_COLUMN_COUNT)).toEqual([
      "",
      "A Bakery",
      "Baker",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  });
});

describe("the review file format", () => {
  it("ends every record with CRLF, as slt-jobs.csv does", () => {
    const text = csvOf([job]);
    expect(text.split("\r\n")).toHaveLength(2);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("stops without a trailing newline, as slt-jobs.csv does", () => {
    expect(csvOf([job]).endsWith("\n")).toBe(false);
  });

  it("round-trips a description holding a comma, a quote, and a newline", () => {
    const description = 'Bake "fresh" cookies, nightly.\nDeliver them.';
    const rows = readAsSpreadsheetWould(csvOf([{ ...job, description }]));
    expect(rows).toHaveLength(2);
    expect(rows[1][7]).toBe(description);
  });

  it("round-trips a description whose only special character is a newline", () => {
    const description = "Bake cookies.\nDeliver them.";
    const rows = readAsSpreadsheetWould(csvOf([{ ...job, description }]));
    expect(rows).toHaveLength(2);
    expect(rows[1][7]).toBe(description);
  });

  it("round-trips a description whose only special character is a carriage return", () => {
    const description = "Bake cookies.\rDeliver them.";
    const rows = readAsSpreadsheetWould(csvOf([{ ...job, description }]));
    expect(rows).toHaveLength(2);
    expect(rows[1][7]).toBe(description);
  });

  it("round-trips a description holding a carriage return", () => {
    const description = "Bake cookies.\r\nDeliver them.";
    const rows = readAsSpreadsheetWould(csvOf([{ ...job, description }]));
    expect(rows).toHaveLength(2);
    expect(rows[1][7]).toBe(description);
  });
});

describe("the write allowlist", () => {
  it("writes exactly the review file on a full pass over the Lever fixture", () => {
    const { adapter, config } = leverSource;
    const { entries } = adapter.parseListing(LISTING_FIXTURE);
    const postings = adapter.selectLocal(entries, config);
    expect(postings.length).toBeGreaterThan(0);

    writeReviewCsv(
      postings.map((posting) => toReviewRow(toReviewJob(leverSource, posting))),
      root,
    );

    expect(listFiles(root)).toEqual(["review/new-jobs.csv"]);
  });

  it("throws rather than write the file the board is built from", () => {
    expect(() => writeAllowedFile("slt-jobs.csv", "ruined", root)).toThrow(
      WriteOutsideAllowlistError,
    );
    expect(existsSync(join(root, "slt-jobs.csv"))).toBe(false);
  });

  it("throws rather than write the job data the site renders", () => {
    expect(() => writeAllowedFile("jobboard.json", "[]", root)).toThrow(
      WriteOutsideAllowlistError,
    );
    expect(existsSync(join(root, "jobboard.json"))).toBe(false);
  });

  it("throws for a path that climbs out of an allowed directory", () => {
    expect(() =>
      writeAllowedFile(join("review", "..", "slt-jobs.csv"), "ruined", root),
    ).toThrow(WriteOutsideAllowlistError);
    expect(existsSync(join(root, "slt-jobs.csv"))).toBe(false);
  });

  it("throws for an absolute path outside the repository", () => {
    expect(() =>
      writeAllowedFile(join(tmpdir(), "escaped.csv"), "escaped", root),
    ).toThrow(WriteOutsideAllowlistError);
  });

  it("throws for the allowed directory itself", () => {
    expect(() => writeAllowedFile("review", "ruined", root)).toThrow(
      WriteOutsideAllowlistError,
    );
  });

  it("writes a file under scripts/data", () => {
    writeAllowedFile(join("scripts", "data", "state.json"), "{}", root);
    expect(
      readFileSync(join(root, "scripts", "data", "state.json"), "utf-8"),
    ).toBe("{}");
  });

  it("rewrites the review file in place on a second run", () => {
    writeReviewCsv([toReviewRow(job)], root);
    writeReviewCsv([], root);

    const text = readFileSync(join(root, REVIEW_CSV_PATH), "utf-8");
    expect(text.split("\r\n")).toHaveLength(1);
  });
});
