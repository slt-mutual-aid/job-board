import { readFileSync } from "fs";
import { join, resolve } from "path";
import { REPOSITORY_ROOT, writeAllowedFile } from "./review-csv";

export const SOURCES_STATE_PATH = join("scripts", "data", "sources-state.json");

// A posting the reviewer declined must not come back as if it were new, and a
// key dropped from the file is exactly that. Ninety days outlasts the seasonal
// gap between a posting being withdrawn and the same opening being relisted,
// which is the longest absence that still means one hiring decision.
export const PRUNE_AFTER_DAYS = 90;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PostingRecord {
  // Dates the last run that found the posting, which is what pruning ages out.
  lastSeen: string;
  // Carried so a person opening the state file recognizes the posting a key
  // stands for.
  title: string;
  url: string;
  // True once the reviewer has recorded a decision about the posting in the
  // review file. It never returns to false: the review file is rewritten on
  // every run, so the state file holds the only lasting record of a decision.
  decided: boolean;
}

export interface SourcesState {
  postings: Record<string, PostingRecord>;
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
  // Postings the reviewer has not decided about, which is what the review file
  // carries.
  undecided: SeenPosting[];
}

export function emptyState(): SourcesState {
  return { postings: {} };
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

  const { lastSeen, title, url, decided } = value;
  if (
    !isTimestamp(lastSeen) ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof decided !== "boolean"
  ) {
    return undefined;
  }

  return { lastSeen, title, url, decided };
}

// A record that fails to parse is dropped on its own rather than taking the
// file with it, so one damaged entry re-proposes one posting instead of every
// posting the reviewer has already decided. A document that is not a state
// file at all yields undefined, which the caller reports.
export function parseSourcesState(raw: string): SourcesState | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isObject(decoded) || !isObject(decoded.postings)) {
    return undefined;
  }

  const state = emptyState();
  for (const [key, value] of Object.entries(decoded.postings)) {
    const record = toPostingRecord(value);
    if (record !== undefined) {
      state.postings[key] = record;
    }
  }

  return state;
}

// A damaged file is treated as a first run and said out loud, because the
// quiet version of the same fallback looks exactly like a genuine first run
// while it re-proposes every posting the reviewer has already decided.
// Refusing to run instead would leave the reviewer with no way to fetch
// postings until someone repaired a file that only records past runs.
export function loadSourcesState(root: string = REPOSITORY_ROOT): SourcesState {
  const target = resolve(root, SOURCES_STATE_PATH);

  let raw: string;
  try {
    raw = readFileSync(target, "utf-8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT") {
      console.warn(
        `Warning: ${SOURCES_STATE_PATH} cannot be read (${code ?? "unknown error"}). Every posting found now counts as undecided.`,
      );
    }
    return emptyState();
  }

  const state = parseSourcesState(raw);
  if (state === undefined) {
    console.warn(
      `Warning: ${SOURCES_STATE_PATH} is not a readable state file. Every posting found now counts as undecided.`,
    );
    return emptyState();
  }

  return state;
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
  postings: readonly SeenPosting[],
  now: Date,
): RunResult {
  const timestamp = now.toISOString();
  const nextPostings = { ...state.postings };
  const undecided: SeenPosting[] = [];

  for (const posting of postings) {
    const existing = nextPostings[posting.key];
    nextPostings[posting.key] = {
      lastSeen: timestamp,
      title: posting.title,
      url: posting.url,
      decided: existing?.decided ?? false,
    };
    if (existing?.decided !== true) {
      undecided.push(posting);
    }
  }

  return { state: { postings: nextPostings }, undecided };
}

// Called with the decisions read out of the review file, before that file is
// rewritten. A key the state file does not carry is skipped, whether the
// posting was pruned, dropped as a damaged record, or typed by hand.
export function markDecided(
  state: SourcesState,
  keys: readonly string[],
): SourcesState {
  const postings = { ...state.postings };
  for (const key of keys) {
    const record = postings[key];
    if (record !== undefined) {
      postings[key] = { ...record, decided: true };
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
