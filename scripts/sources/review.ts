import { toSpreadsheetDate } from "./date";
import { judgeFit } from "./fit";
import {
  assess,
  observedFailure,
  previousCountOf,
  readHealthFile,
  type SourceAssessment,
  type SourceHealthStatus,
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
import {
  DECISION_HEADER,
  SOURCE_HEADER,
  cellOf,
  decidedKeys,
  readReviewRows,
  sortRowsByFit,
  toReviewRow,
  writeReviewCsv,
  type ReviewJob,
  type ReviewRow,
} from "./review-csv";
import {
  loadSourcesState,
  markDecided,
  postingKey,
  pruneSourcesState,
  recordRun,
  saveSourcesState,
  type SourcesState,
} from "./state";
import { htmlToPlainText } from "./text";
import type {
  IdentifiedEntry,
  ListingOnlyAdapter,
  ListingThenDetailAdapter,
  SourcePosting,
} from "./types";

// What a review row needs about the listing it came from, beyond the posting.
export interface ReviewSource {
  sourceId: string;
  accountId: string;
  companyName: string;
}

export interface ReviewReader extends ReviewSource {
  read(): Promise<SourceObservation<SourcePosting>>;
}

interface CompleteSource<
  Config,
  Entry extends IdentifiedEntry,
> extends ReviewSource {
  adapter: ListingOnlyAdapter<Config> | ListingThenDetailAdapter<Config, Entry>;
  config: Config;
}

// Hourly Rate stays empty on every row: no source on this list publishes a
// wage, and a number invented here reaches a job seeker as fact.
export function toReviewJob(
  source: ReviewSource,
  posting: SourcePosting,
): ReviewJob {
  const fit = judgeFit(posting);

  return {
    // The spreadsheet column this value is copied into reads M/D/YYYY.
    datePosted: toSpreadsheetDate(posting.postedAt),
    company: source.companyName,
    title: posting.title,
    applicationLink: posting.applyLink,
    typeOfWork: posting.commitment,
    location: posting.location,
    // Some sources publish a description as markup and some as text. One pass
    // for every source keeps markup out of the spreadsheet cell and holds every
    // description to the length a person can read there.
    description:
      posting.description === undefined
        ? undefined
        : htmlToPlainText(posting.description),
    closesBy:
      posting.closesAt === undefined
        ? undefined
        : toSpreadsheetDate(posting.closesAt),
    sourceId: source.sourceId,
    // The platform's own identifier, not the apply link, whose tracking
    // parameters change between runs and would make one posting look new every
    // time.
    postingKey: postingKey(source.accountId, posting.id),
    fit: fit.verdict,
    fitReason: fit.reason,
  };
}

// Written one source at a time because the type parameters are inferred from a
// single concrete source, which a loop over the registry cannot supply.
export function readerFor<Config, Entry extends IdentifiedEntry>(
  source: CompleteSource<Config, Entry>,
): ReviewReader {
  const { adapter, config, sourceId } = source;

  return {
    ...source,
    read: async (): Promise<SourceObservation<SourcePosting>> => {
      try {
        if (adapter.shape === "listing-only") {
          const raw = await adapter.fetchListingRaw(config);
          const { entries, confirmedEmpty } = adapter.parseListing(raw);
          return {
            kind: "reading",
            sourceId,
            postings: adapter.selectLocal(entries, config),
            entryCount: entries.length,
            confirmedEmpty,
          };
        }

        const raw = await adapter.fetchListingRaw(config);
        const { entries, confirmedEmpty } = adapter.parseListing(raw);
        // A row carries a posting date and a description, and this shape of
        // source publishes neither in its listing, so every selected entry
        // costs a second request.
        const postings: SourcePosting[] = [];
        for (const entry of adapter.selectLocal(entries, config)) {
          const detail = await adapter.fetchDetailRaw(config, entry);
          postings.push(adapter.parseDetail(detail, entry));
        }

        return {
          kind: "reading",
          sourceId,
          postings,
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
// unread while the review file still reads as the whole town's openings.
export const readers: ReviewReader[] = [
  readerFor(leverSource),
  readerFor(bambooHrSource),
  readerFor(icimsOvgSource),
  readerFor(icimsDavidsonSource),
  readerFor(oracleCaesarsSource),
  readerFor(oracleRaleysSource),
  readerFor(ukgSource),
];

export interface SourceRowCount {
  sourceId: string;
  status: SourceHealthStatus;
  rowCount: number;
  // True where the rows are the ones an earlier run wrote, because this run
  // found the source unfit to speak for the employer.
  carriedForward: boolean;
}

export interface ReviewPlan {
  rows: ReviewRow[];
  state: SourcesState;
  counts: SourceRowCount[];
}

export interface ReviewPlanInput {
  assessments: readonly SourceAssessment<SourcePosting>[];
  sources: readonly ReviewSource[];
  // What the file carried before this run, which is where a decision is read
  // from and where the rows of an unfit source are kept.
  previousRows: readonly ReviewRow[];
  state: SourcesState;
  now: Date;
}

export class UnknownReviewSourceError extends Error {
  constructor(sourceId: string) {
    super(`No review source is registered as ${sourceId}`);
    this.name = "UnknownReviewSourceError";
  }
}

// Builds the whole file from every source at once, which is what keeps one
// source's rows from replacing another's. Pure, so the decision rules can be
// exercised without a request.
export function planReviewFile(input: ReviewPlanInput): ReviewPlan {
  const sourcesById = new Map(
    input.sources.map((source) => [source.sourceId, source]),
  );

  // Read out of the file before the rewrite that drops the rows carrying them.
  let state = markDecided(input.state, decidedKeys(input.previousRows));

  const rows: ReviewRow[] = [];
  const counts: SourceRowCount[] = [];

  for (const assessment of input.assessments) {
    const source = sourcesById.get(assessment.sourceId);
    if (source === undefined) {
      throw new UnknownReviewSourceError(assessment.sourceId);
    }

    if (assessment.status !== "healthy") {
      // A rewrite that left the source out would read as an employer with
      // nothing open, and the reviewer would watch its rows vanish on a run
      // that only failed to reach the site. The rows an earlier run wrote
      // stand until a healthy run replaces them.
      const carried = input.previousRows.filter(
        (row) =>
          cellOf(row, SOURCE_HEADER) === assessment.sourceId &&
          cellOf(row, DECISION_HEADER) === "",
      );
      rows.push(...carried);
      counts.push({
        sourceId: assessment.sourceId,
        status: assessment.status,
        rowCount: carried.length,
        carriedForward: true,
      });
      continue;
    }

    const run = recordRun(
      state,
      assessment.postings.map((posting) => ({
        key: postingKey(source.accountId, posting.id),
        title: posting.title,
        url: posting.applyLink,
      })),
      input.now,
    );
    state = run.state;

    // The file carries every posting the reviewer has not decided about, not
    // only the ones this run saw first. A rewrite holding the new ones alone
    // drops postings an earlier run put there, and no later run offers them
    // again. A posting the employer has withdrawn leaves the listing and
    // therefore the file, so nobody reviews an opening that is closed.
    const owed = new Set(run.undecided.map((posting) => posting.key));
    const fresh = assessment.postings
      .filter((posting) => owed.has(postingKey(source.accountId, posting.id)))
      .map((posting) => toReviewRow(toReviewJob(source, posting)));

    rows.push(...fresh);
    counts.push({
      sourceId: assessment.sourceId,
      status: assessment.status,
      rowCount: fresh.length,
      carriedForward: false,
    });
  }

  // Ordering is the last step, so a source that answered late in the run still
  // reaches the top of the file when its postings are the ones to read first.
  return {
    rows: sortRowsByFit(rows),
    state: pruneSourcesState(state, input.now),
    counts,
  };
}

export function formatReviewSummary(counts: readonly SourceRowCount[]): string {
  const lines = counts.map((count) =>
    count.carriedForward
      ? `${count.sourceId}: ${count.rowCount} row(s) an earlier run wrote, kept because this run found the source ${count.status}`
      : `${count.sourceId}: ${count.rowCount} row(s) awaiting a decision`,
  );

  const total = counts.reduce((sum, count) => sum + count.rowCount, 0);
  lines.push(`${total} row(s) in total`);
  return lines.join("\n");
}

export interface ReviewRunResult {
  target: string;
  counts: SourceRowCount[];
  assessments: SourceAssessment<SourcePosting>[];
}

// The health file is read and never written here. Its counts are the baseline
// the drop rule compares against, and a count this command appended would
// become the baseline the scheduled check then reads, hiding a drop that
// happened between two scheduled runs.
export async function runReview(
  sourceReaders: readonly ReviewReader[],
  now: Date,
  root?: string,
): Promise<ReviewRunResult> {
  const observations: SourceObservation<SourcePosting>[] = [];
  for (const reader of sourceReaders) {
    console.log(`Reading ${reader.sourceId}...`);
    observations.push(await reader.read());
  }

  const health = readHealthFile(root);
  const assessments = observations.map((observation) =>
    assess(observation, previousCountOf(health, observation.sourceId)),
  );

  const plan = planReviewFile({
    assessments,
    sources: sourceReaders,
    previousRows: readReviewRows(root),
    state: loadSourcesState(root),
    now,
  });

  // Saved before the rewrite, because the rewrite is what drops a decided row
  // from the review file. A write that fails after the save leaves the review
  // file holding those same decisions, and the state file already carries
  // them, so neither copy of a decision depends on the other write reaching
  // disk.
  saveSourcesState(plan.state, root);
  const target = writeReviewCsv(plan.rows, root);

  return { target, counts: plan.counts, assessments };
}
