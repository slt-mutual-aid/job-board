import { toSpreadsheetDate } from "./date";
import { bambooHrSource } from "./registry";
import type { SourcePosting } from "./types";

const { adapter, config } = bambooHrSource;

function describeLiveness(posting: SourcePosting): string {
  const { liveness } = posting;
  if (liveness === undefined) {
    return "unknown";
  }
  return liveness.isOpen ? liveness.status : `${liveness.status} (closed)`;
}

const COLUMNS: Array<{
  header: string;
  value: (posting: SourcePosting) => string;
}> = [
  // The spreadsheet column this output is copied into reads M/D/YYYY.
  { header: "POSTED", value: (posting) => toSpreadsheetDate(posting.postedAt) },
  { header: "TITLE", value: (posting) => posting.title },
  { header: "TYPE", value: (posting) => posting.commitment ?? "" },
  { header: "STATUS", value: describeLiveness },
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
  const { entries, confirmedEmpty } = adapter.parseListing(
    await adapter.fetchListingRaw(config),
  );
  const local = adapter.selectLocal(entries, config);

  if (local.length === 0) {
    console.log(
      confirmedEmpty
        ? `No postings at ${config.city}`
        : `No postings at ${config.city} after the local location filter`,
    );
    return;
  }

  console.log(`Fetching ${local.length} detail page(s)...`);
  const postings: SourcePosting[] = [];
  for (const entry of local) {
    postings.push(
      adapter.parseDetail(await adapter.fetchDetailRaw(config, entry), entry),
    );
  }

  printTable(postings);
  console.log(`${postings.length} posting(s)`);
}

main().catch((error: Error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
