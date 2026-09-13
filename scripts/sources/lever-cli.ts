import { fileURLToPath } from "url";
import { toSpreadsheetDate } from "./date";
import { leverSource } from "./registry";
import { htmlToPlainText } from "./text";
import {
  readReviewDecisions,
  writeReviewCsv,
  type ReviewJob,
} from "./review-csv";
import {
  loadSourcesState,
  markDecided,
  postingKey,
  pruneSourcesState,
  recordRun,
  saveSourcesState,
  type SeenPosting,
} from "./state";
import type { SourcePosting } from "./types";

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

// The work behind --write-review, with the repository root as a parameter so a
// test can drive it against a temporary directory.
export function writeReviewFile(
  postings: readonly SourcePosting[],
  now: Date,
  root?: string,
): { target: string; queued: number } {
  const decided = markDecided(
    loadSourcesState(root),
    readReviewDecisions(root),
  );
  const { state, undecided } = recordRun(
    decided,
    postings.map(toSeenPosting),
    now,
  );
  const owed = new Set(undecided.map((posting) => posting.key));

  // The file carries every posting the reviewer has not decided about, not
  // only the ones this run saw first. A rewrite holding the new ones alone
  // drops postings an earlier run put there, and no later run offers them
  // again. A posting Lever has withdrawn leaves the listing and therefore the
  // file, so nobody reviews an opening that is closed.
  const queued = postings.filter((posting) =>
    owed.has(postingKey(SOURCE_ID, posting.id)),
  );

  // Saved before the rewrite, because the rewrite is what drops a decided row
  // from the review file. A write that fails after the save leaves the review
  // file holding those same decisions, and the state file already carries
  // them, so neither copy of a decision depends on the other write reaching
  // disk.
  saveSourcesState(pruneSourcesState(state, now), root);
  const target = writeReviewCsv(queued.map(toReviewJob), root);

  return { target, queued: queued.length };
}

async function main(): Promise<void> {
  const writeReview = process.argv.slice(2).includes(WRITE_REVIEW_FLAG);

  console.log(`Fetching ${adapter.listingUrl(config)}`);

  const raw = await adapter.fetchListingRaw(config);
  console.log("Parsing response...");
  const listing = adapter.parseListing(raw);

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
    const { target, queued } = writeReviewFile(postings, new Date());
    console.log(`Wrote ${target}`);
    console.log(
      `${queued} posting(s) of ${postings.length} awaiting a decision`,
    );
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
