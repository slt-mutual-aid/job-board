import { fileURLToPath } from "url";
import {
  exitCodeFor,
  formatRunSummary,
  observedFailure,
  recordRun,
  type SourceObservation,
} from "./health";
import { bambooHrSource, leverSource } from "./registry";
import type { ListingResult } from "./types";

// The members a health check needs from either adapter shape. A detail request
// answers nothing about whether a source still responds, so the check stops at
// the listing and costs one request per source.
interface ListingSource<Config, Entry> {
  adapter: {
    readonly id: string;
    fetchListingRaw(config: Config): Promise<string>;
    parseListing(raw: string): ListingResult<Entry>;
    selectLocal(entries: Entry[], config: Config): unknown[];
  };
  config: Config;
}

export interface SourceReader {
  id: string;
  read(): Promise<SourceObservation>;
}

// Written one source at a time because the type parameters are inferred from a
// single concrete source, which a loop over the registry cannot supply.
function readerFor<Config, Entry>(
  source: ListingSource<Config, Entry>,
): SourceReader {
  const { adapter, config } = source;
  return {
    id: adapter.id,
    read: async (): Promise<SourceObservation> => {
      try {
        const raw = await adapter.fetchListingRaw(config);
        const { entries, confirmedEmpty } = adapter.parseListing(raw);
        return {
          kind: "reading",
          sourceId: adapter.id,
          postingCount: adapter.selectLocal(entries, config).length,
          confirmedEmpty,
        };
      } catch (error) {
        return observedFailure(adapter.id, error);
      }
    },
  };
}

// Held to the registry by the coverage test, so a source added later cannot go
// unchecked while the summary still reads as complete.
export const readers: SourceReader[] = [
  readerFor(leverSource),
  readerFor(bambooHrSource),
];

async function main(): Promise<void> {
  const observations: SourceObservation[] = [];
  for (const reader of readers) {
    console.log(`Checking ${reader.id}...`);
    observations.push(await reader.read());
  }

  const assessments = recordRun(observations, { now: new Date() });
  console.log(formatRunSummary(assessments));
  process.exitCode = exitCodeFor(assessments);
}

// Importing this file from a test must not fetch every source.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
