import { toSpreadsheetDate } from "./date";
import { icimsDavidsonSource, icimsOvgSource } from "./registry";
import type { IcimsConfig } from "./adapters/icims";
import type { SourcePosting } from "./types";

// One adapter reads both accounts, so the command prints one table per
// employer rather than one table of postings from two employers.
const SOURCES = [icimsOvgSource, icimsDavidsonSource];

const COLUMNS: Array<{
  header: string;
  value: (posting: SourcePosting) => string;
}> = [
  // The spreadsheet column this output is copied into reads M/D/YYYY.
  { header: "POSTED", value: (posting) => toSpreadsheetDate(posting.postedAt) },
  { header: "TITLE", value: (posting) => posting.title },
  { header: "TYPE", value: (posting) => posting.commitment ?? "" },
  { header: "LOCATION", value: (posting) => posting.location },
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

function describePlace(config: IcimsConfig): string {
  return `${config.searchZip} within ${config.searchRadiusMiles} miles`;
}

async function main(): Promise<void> {
  for (const { adapter, config, sourceId } of SOURCES) {
    console.log(`Fetching ${adapter.listingUrl(config)}`);
    const { entries, confirmedEmpty } = adapter.parseListing(
      await adapter.fetchListingRaw(config),
    );
    const postings = adapter.selectLocal(entries, config);

    if (postings.length === 0) {
      console.log(
        confirmedEmpty
          ? `No ${sourceId} postings near ${describePlace(config)}`
          : `No ${sourceId} postings at ${config.locations.join(" or ")} after the local location filter`,
      );
      continue;
    }

    printTable(postings);
    console.log(`${postings.length} ${sourceId} posting(s)`);
  }
}

main().catch((error: Error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
