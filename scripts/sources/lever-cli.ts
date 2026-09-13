import {
  fetchRaw,
  parse,
  buildUrl,
  type LeverConfig,
  type LeverPosting,
} from "./adapters/lever";

const config: LeverConfig = {
  company: "insomniacookies",
  location: "South Lake Tahoe CA",
};

const COLUMNS: Array<{
  header: string;
  value: (posting: LeverPosting) => string;
}> = [
  { header: "POSTED", value: (posting) => posting.postedDate },
  { header: "TITLE", value: (posting) => posting.title },
  { header: "TYPE", value: (posting) => posting.commitment ?? "" },
  { header: "APPLY LINK", value: (posting) => posting.applyLink },
];

function printTable(postings: LeverPosting[]): void {
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
  console.log(`Fetching ${buildUrl(config)}`);
  const raw = await fetchRaw(config);

  console.log("Parsing response...");
  const { postings, confirmedEmpty } = parse(raw, config);

  if (postings.length === 0) {
    console.log(
      confirmedEmpty
        ? `No postings at ${config.location}`
        : `No postings at ${config.location} after the local location filter`,
    );
    return;
  }

  printTable(postings);
  console.log(`${postings.length} posting(s)`);
}

main().catch((error: Error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
