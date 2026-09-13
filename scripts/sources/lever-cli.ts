import { toSpreadsheetDate } from "./date";
import { leverSource } from "./registry";
import type { SourcePosting } from "./types";

const { adapter, config } = leverSource;

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
}

main().catch((error: Error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
