import { fileURLToPath } from "url";
import { toSpreadsheetDate } from "./date";
import { leverSource } from "./registry";
import { htmlToPlainText } from "./text";
import { writeReviewCsv, type ReviewJob } from "./review-csv";
import {
  loadSourcesState,
  markReported,
  postingKey,
  pruneSourcesState,
  recordFailedRun,
  recordRun,
  saveSourcesState,
  type SeenPosting,
} from "./state";
import type { ListingResult, SourcePosting } from "./types";

const { adapter, config } = leverSource;

// The Lever account this command follows, and the namespace of every posting
// key it records.
export const SOURCE_ID = `lever:${config.company}`;

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
    sourceId: postingKey(SOURCE_ID, posting.id),
  };
}

// Lever's posting id, not the apply link, which carries tracking parameters
// that change between runs.
function toSeenPosting(posting: SourcePosting): SeenPosting {
  return {
    key: postingKey(SOURCE_ID, posting.id),
    title: posting.title,
    url: posting.applyLink,
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

  let listing: ListingResult<SourcePosting>;
  try {
    const raw = await adapter.fetchListingRaw(config);
    console.log("Parsing response...");
    listing = adapter.parseListing(raw);
  } catch (error) {
    // Dating the attempt separates a source with nothing new from one that has
    // stopped answering.
    if (writeReview) {
      saveSourcesState(
        recordFailedRun(loadSourcesState(), SOURCE_ID, new Date()),
      );
    }
    throw error;
  }

  const postings = adapter.selectLocal(listing.entries, config);

  if (postings.length === 0) {
    console.log(
      listing.confirmedEmpty
        ? `No postings at ${config.location}`
        : `No postings at ${config.location} after the local location filter`,
    );
  } else {
    printTable(postings);
    console.log(`${postings.length} posting(s)`);
  }

  if (writeReview) {
    const now = new Date();
    const { state, unreported } = recordRun(
      loadSourcesState(),
      SOURCE_ID,
      postings.map(toSeenPosting),
      now,
    );
    const owed = new Set(unreported.map((posting) => posting.key));

    // Only a first sighting reaches the reviewer. Putting a posting they
    // already declined back in front of them is what empties a review queue of
    // meaning, and the file is rewritten from this run alone so a posting Lever
    // has withdrawn stops facing them as if it were open.
    const fresh = postings.filter((posting) =>
      owed.has(postingKey(SOURCE_ID, posting.id)),
    );
    console.log(`Wrote ${writeReviewCsv(fresh.map(toReviewJob))}`);
    console.log(`${fresh.length} new posting(s) of ${postings.length}`);

    saveSourcesState(pruneSourcesState(markReported(state, [...owed]), now));
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
