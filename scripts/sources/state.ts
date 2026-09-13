import { readFileSync } from "fs";
import { join, resolve } from "path";
import { REPOSITORY_ROOT, writeAllowedFile } from "./review-csv";

export const SOURCES_STATE_PATH = join("scripts", "data", "sources-state.json");

// A posting the reviewer declined must not come back as if it were new, and a
// key dropped from the file is exactly that. Ninety days outlasts the seasonal
// gap between a posting being withdrawn and the same opening being relisted,
// which is the longest absence that still means one hiring decision.
export const PRUNE_AFTER_DAYS = 90;

// Long enough to show a source sliding towards zero, short enough that the
// file does not grow with every run.
export const RUN_COUNT_HISTORY = 10;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PostingRecord {
  firstSeen: string;
  lastSeen: string;
  title: string;
  url: string;
  // True once the posting has reached a reviewer. It never returns to false,
  // because a reviewer who declined a posting has already decided it.
  reported: boolean;
}

export interface SourceRecord {
  lastRun: string;
  // Absent until one run of the source reaches a posting list. A gap between
  // the two timestamps is a source that answers with an error.
  lastSuccessfulRun?: string;
  // Postings returned by each of the most recent successful runs, oldest
  // first. Nothing reads it yet; it is here so a later change can tell a
  // source that has silently stopped returning results from a quiet week.
  recentCounts: number[];
}

export interface SourcesState {
  postings: Record<string, PostingRecord>;
  sources: Record<string, SourceRecord>;
}

// One posting as a run found it. The key is the identity; the title and the
// url are carried so the file stays readable by a person.
export interface SeenPosting {
  key: string;
  title: string;
  url: string;
}

export interface RunResult {
  state: SourcesState;
  // Postings seen for the first time and still owed to a reviewer.
  unreported: SeenPosting[];
}

export function emptyState(): SourcesState {
  return { postings: {}, sources: {} };
}

// The identifier comes from the platform rather than from the apply link,
// whose tracking parameters differ between runs and would make one posting
// look like a new one every time. The source owns a namespace in the key so
// two platforms handing out the same identifier cannot overwrite each other.
export function postingKey(sourceId: string, postingId: string): string {
  return `${sourceId}:${postingId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function toPostingRecord(value: unknown): PostingRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const { firstSeen, lastSeen, title, url, reported } = value;
  if (
    !isTimestamp(firstSeen) ||
    !isTimestamp(lastSeen) ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof reported !== "boolean"
  ) {
    return undefined;
  }

  return { firstSeen, lastSeen, title, url, reported };
}

function toSourceRecord(value: unknown): SourceRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const { lastRun, lastSuccessfulRun, recentCounts } = value;
  if (!isTimestamp(lastRun)) {
    return undefined;
  }
  if (lastSuccessfulRun !== undefined && !isTimestamp(lastSuccessfulRun)) {
    return undefined;
  }
  if (
    !Array.isArray(recentCounts) ||
    !recentCounts.every(
      (count) => typeof count === "number" && Number.isFinite(count),
    )
  ) {
    return undefined;
  }

  const record: SourceRecord = { lastRun, recentCounts };
  if (lastSuccessfulRun !== undefined) {
    record.lastSuccessfulRun = lastSuccessfulRun;
  }
  return record;
}

// A record that fails to parse is dropped on its own rather than taking the
// file with it, so one damaged entry re-proposes one posting instead of every
// posting the reviewer has already seen.
export function parseSourcesState(raw: string): SourcesState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return emptyState();
  }

  if (!isObject(decoded)) {
    return emptyState();
  }

  const state = emptyState();

  if (isObject(decoded.postings)) {
    for (const [key, value] of Object.entries(decoded.postings)) {
      const record = toPostingRecord(value);
      if (record !== undefined) {
        state.postings[key] = record;
      }
    }
  }

  if (isObject(decoded.sources)) {
    for (const [key, value] of Object.entries(decoded.sources)) {
      const record = toSourceRecord(value);
      if (record !== undefined) {
        state.sources[key] = record;
      }
    }
  }

  return state;
}

// An unreadable file is treated as a first run. Refusing to run instead would
// leave the reviewer with no way to fetch postings until someone repaired a
// file that only holds a record of past runs.
export function loadSourcesState(root: string = REPOSITORY_ROOT): SourcesState {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, SOURCES_STATE_PATH), "utf-8");
  } catch {
    return emptyState();
  }
  return parseSourcesState(raw);
}

// Routed through the allowlist of review-csv.ts, which already permits
// scripts/data, so a bug here cannot reach slt-jobs.csv or jobboard.json.
export function saveSourcesState(state: SourcesState, root?: string): string {
  return writeAllowedFile(
    SOURCES_STATE_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
    root,
  );
}

export function recordRun(
  state: SourcesState,
  sourceId: string,
  postings: readonly SeenPosting[],
  now: Date,
): RunResult {
  const timestamp = now.toISOString();
  const nextPostings = { ...state.postings };
  const unreported: SeenPosting[] = [];

  for (const posting of postings) {
    const existing = nextPostings[posting.key];
    nextPostings[posting.key] = {
      firstSeen: existing?.firstSeen ?? timestamp,
      lastSeen: timestamp,
      title: posting.title,
      url: posting.url,
      reported: existing?.reported ?? false,
    };
    if (existing?.reported !== true) {
      unreported.push(posting);
    }
  }

  const previous = state.sources[sourceId];
  const record: SourceRecord = {
    lastRun: timestamp,
    lastSuccessfulRun: timestamp,
    recentCounts: [...(previous?.recentCounts ?? []), postings.length].slice(
      -RUN_COUNT_HISTORY,
    ),
  };

  return {
    state: {
      postings: nextPostings,
      sources: { ...state.sources, [sourceId]: record },
    },
    unreported,
  };
}

// A run that never reached a posting list appends no count, so the history
// keeps meaning the number of postings a source returned when it answered.
export function recordFailedRun(
  state: SourcesState,
  sourceId: string,
  now: Date,
): SourcesState {
  const previous = state.sources[sourceId];
  const record: SourceRecord = {
    lastRun: now.toISOString(),
    recentCounts: previous?.recentCounts ?? [],
  };
  if (previous?.lastSuccessfulRun !== undefined) {
    record.lastSuccessfulRun = previous.lastSuccessfulRun;
  }

  return { ...state, sources: { ...state.sources, [sourceId]: record } };
}

// Called once the review file is on disk. Marking before the write would lose
// a posting to a failed write with nothing left to say it was never delivered.
export function markReported(
  state: SourcesState,
  keys: readonly string[],
): SourcesState {
  const postings = { ...state.postings };
  for (const key of keys) {
    const record = postings[key];
    if (record !== undefined) {
      postings[key] = { ...record, reported: true };
    }
  }

  return { ...state, postings };
}

export function pruneSourcesState(
  state: SourcesState,
  now: Date,
): SourcesState {
  const cutoff = now.getTime() - PRUNE_AFTER_DAYS * MILLISECONDS_PER_DAY;
  const postings: Record<string, PostingRecord> = {};

  for (const [key, record] of Object.entries(state.postings)) {
    if (Date.parse(record.lastSeen) > cutoff) {
      postings[key] = record;
    }
  }

  return { ...state, postings };
}
