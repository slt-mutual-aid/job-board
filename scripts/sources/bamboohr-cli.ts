import {
  fetchListingRaw,
  fetchDetailRaw,
  parseListing,
  parseDetail,
  selectLocal,
  listingUrl,
  type BambooHrConfig,
  type BambooHrPosting,
} from "./adapters/bamboohr";

const config: BambooHrConfig = {
  subdomain: "vra",
  city: "South Lake Tahoe",
};

const COLUMNS: Array<{
  header: string;
  value: (posting: BambooHrPosting) => string;
}> = [
  { header: "POSTED", value: (posting) => posting.postedDate },
  { header: "TITLE", value: (posting) => posting.title },
  { header: "TYPE", value: (posting) => posting.commitment },
  {
    header: "STATUS",
    value: (posting) =>
      posting.isOpen ? posting.status : `${posting.status} (closed)`,
  },
  { header: "APPLY LINK", value: (posting) => posting.applyLink },
];

function printTable(postings: BambooHrPosting[]): void {
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
  console.log(`Fetching ${listingUrl(config)}`);
  const { entries, confirmedEmpty } = parseListing(
    await fetchListingRaw(config),
  );
  const local = selectLocal(entries, config);

  if (local.length === 0) {
    console.log(
      confirmedEmpty
        ? `No postings at ${config.city}`
        : `No postings at ${config.city} after the local location filter`,
    );
    return;
  }

  console.log(`Fetching ${local.length} detail page(s)...`);
  const postings: BambooHrPosting[] = [];
  for (const entry of local) {
    postings.push(parseDetail(await fetchDetailRaw(config, entry.id), entry));
  }

  printTable(postings);
  console.log(`${postings.length} posting(s)`);
}

main().catch((error: Error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
