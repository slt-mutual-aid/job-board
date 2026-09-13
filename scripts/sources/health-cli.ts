import { fileURLToPath } from "url";
import {
  exitCodeFor,
  formatRunSummary,
  observedFailure,
  recordRun,
  type SourceObservation,
} from "./health";
import {
  bambooHrSource,
  icimsDavidsonSource,
  icimsOvgSource,
  leverSource,
  oracleCaesarsSource,
  oracleRaleysSource,
  ukgSource,
} from "./registry";
import type { AdapterBase, IdentifiedEntry } from "./types";

// A detail request answers nothing about whether a source still responds, so
// the check stops at the listing and costs one request per source.
interface ListingSource<Config, Entry extends IdentifiedEntry> {
  adapter: AdapterBase<Config, Entry>;
  config: Config;
  // One employer's listing, which is what a health record is about. Two
  // employers read by one adapter carry two of these.
  sourceId: string;
}

export interface SourceReader {
  id: string;
  // The postings keep their identifiers, which is what lets a consumer ask
  // whether one named posting is still listed.
  read(): Promise<SourceObservation<IdentifiedEntry>>;
}

// Written one source at a time because the type parameters are inferred from a
// single concrete source, which a loop over the registry cannot supply.
function readerFor<Config, Entry extends IdentifiedEntry>(
  source: ListingSource<Config, Entry>,
): SourceReader {
  const { adapter, config, sourceId } = source;
  return {
    id: sourceId,
    read: async (): Promise<SourceObservation<IdentifiedEntry>> => {
      try {
        const raw = await adapter.fetchListingRaw(config);
        const { entries, confirmedEmpty } = adapter.parseListing(raw);
        return {
          kind: "reading",
          sourceId,
          postings: adapter.selectLocal(entries, config),
          entryCount: entries.length,
          confirmedEmpty,
        };
      } catch (error) {
        return observedFailure(sourceId, error);
      }
    },
  };
}

// Held to the registry by the coverage test, so a source added later cannot go
// unchecked while the summary still reads as complete.
export const readers: SourceReader[] = [
  readerFor(leverSource),
  readerFor(bambooHrSource),
  readerFor(icimsOvgSource),
  readerFor(icimsDavidsonSource),
  readerFor(oracleCaesarsSource),
  readerFor(oracleRaleysSource),
  readerFor(ukgSource),
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
