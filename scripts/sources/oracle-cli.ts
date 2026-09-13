import { toSpreadsheetDate } from "./date";
import { oracleCaesarsSource, oracleRaleysSource } from "./registry";
import type { OracleConfig } from "./adapters/oracle";
import type { ListingOnlyAdapter, SourcePosting } from "./types";

interface OracleSource {
  adapter: ListingOnlyAdapter<OracleConfig>;
  config: OracleConfig;
  // One employer's listing, which is what the health file and the
  // reconciliation report each record separately.
  sourceId: string;
}

// Both employers publish on Oracle HCM Cloud, and one command reads them in
// turn so a person checking the platform makes one pass rather than two.
const employers: OracleSource[] = [oracleCaesarsSource, oracleRaleysSource];

const COLUMNS: Array<{
  header: string;
  value: (posting: SourcePosting) => string;
}> = [
  // The spreadsheet columns this output is copied into read M/D/YYYY.
  { header: "POSTED", value: (posting) => toSpreadsheetDate(posting.postedAt) },
  {
    header: "CLOSES",
    value: (posting) =>
      posting.closesAt === undefined ? "" : toSpreadsheetDate(posting.closesAt),
  },
  { header: "TITLE", value: (posting) => posting.title },
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

async function readEmployer(source: OracleSource): Promise<void> {
  const { adapter, config } = source;
  console.log(`Fetching ${adapter.listingUrl(config)}`);

  const { entries, confirmedEmpty } = adapter.parseListing(
    await adapter.fetchListingRaw(config),
  );
  const postings = adapter.selectLocal(entries, config);

  if (postings.length === 0) {
    console.log(
      confirmedEmpty
        ? `No postings at ${config.location}`
        : `No postings at ${config.location} after the local location filter`,
    );
    return;
  }

  printTable(postings);
  console.log(`${postings.length} posting(s) of ${entries.length} listed`);
}

async function main(): Promise<void> {
  for (const source of employers) {
    console.log(`== ${source.sourceId} ==`);
    await readEmployer(source);
  }
}

main().catch((error: Error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
