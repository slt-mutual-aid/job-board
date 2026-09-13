import { fileURLToPath } from "url";
import { toSpreadsheetDate } from "./date";
import { leverSource } from "./registry";
import { htmlToPlainText } from "./text";
import { writeReviewCsv, type ReviewJob } from "./review-csv";
import type { SourcePosting } from "./types";

const { adapter, config } = leverSource;
// The Lever slug identifies an account. The board's Company column carries the
// name a job seeker recognizes, which no Lever field supplies.
const COMPANY_NAME = "Insomnia Cookies";

// Without the flag the command only prints, so the review file is written when
// a person asks for it rather than as a side effect of looking.
const WRITE_REVIEW_FLAG = "--write-review";

const COLUMNS: Array<{
  header: string;
  value: (posting: SourcePosting) => string;
}> = [
  // The spreadsheet column this output is copied into reads M/D/YYYY.
  { header: "POSTED", value: (posting) => toSpreadsheetDate(posting.postedAt) },
  { header: "TITLE", value: (posting) => posting.title },
  { header: "TYPE", value: (posting) => posting.commitment ?? "" },
  { header: "APPLY LINK", value: (posting) => posting.applyLink },
];

// Hourly Rate and Job Closes by stay absent: Lever publishes neither, and a
// wage invented here would reach a job seeker as fact.
export function toReviewJob(posting: SourcePosting): ReviewJob {
  return {
    datePosted: toSpreadsheetDate(posting.postedAt),
    company: COMPANY_NAME,
    title: posting.title,
    applicationLink: posting.applyLink,
    typeOfWork: posting.commitment,
    location: posting.location,
    description:
      posting.description === undefined
        ? undefined
        : htmlToPlainText(posting.description),
    sourceId: `lever:${config.company}:${posting.id}`,
  };
}

function printTable(postings: SourcePosting[]): void {
  const rows = [
    COLUMNS.map((column) => column.header),
    ...postings.map((posting) =>
      COLUMNS.map((column) => column.value(posting)),
    ),
  ];
  const widths = COLUMNS.map((_, index) =>
    Math.max(...rows.map((row) => row[index].length)),
  );

  for (const row of rows) {
    const line = row
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
    console.log(line);
  }
}

async function main(): Promise<void> {
  const writeReview = process.argv.slice(2).includes(WRITE_REVIEW_FLAG);

  console.log(`Fetching ${adapter.listingUrl(config)}`);
  const raw = await adapter.fetchListingRaw(config);

  console.log("Parsing response...");
  const { entries, confirmedEmpty } = adapter.parseListing(raw);
  const postings = adapter.selectLocal(entries, config);

  if (postings.length === 0) {
    console.log(
      confirmedEmpty
        ? `No postings at ${config.location}`
        : `No postings at ${config.location} after the local location filter`,
    );
  } else {
    printTable(postings);
    console.log(`${postings.length} posting(s)`);
  }

  if (writeReview) {
    // A run with no postings still rewrites the file, so a posting Lever has
    // withdrawn stops facing the reviewer as if it were open.
    console.log(`Wrote ${writeReviewCsv(postings.map(toReviewJob))}`);
  }
}

// Running main on import would fetch Lever from a test that only wants the
// posting mapping.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
