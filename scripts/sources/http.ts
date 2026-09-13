import robotsParser from "robots-parser";

// A generic browser string. It carries nothing that identifies the operator or
// this repository, because a request leaving the machine must not name a
// project one person maintains.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15000;

// Most of the employers on this list are small local businesses on shared
// hosting, so the floor applies even where robots.txt asks for nothing.
const MIN_HOST_DELAY_MS = 1000;
const MAX_REQUESTS_PER_HOST = 40;
const MAX_REQUESTS_PER_RUN = 200;
const MAX_REQUESTS_IN_FLIGHT = 2;

type Robots = ReturnType<typeof robotsParser>;

export class RobotsDisallowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobotsDisallowedError";
  }
}

export class RobotsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobotsUnavailableError";
  }
}

export class RequestBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBudgetError";
  }
}

interface HostState {
  origin: string;
  // Requests to one host run one at a time, chained onto this promise.
  queue: Promise<unknown>;
  lastRequestEndedAtMs: number;
  delayMs: number;
  requestCount: number;
  robots: Robots | null;
  robotsText: string;
  robotsLoaded: boolean;
}

const hosts = new Map<string, HostState>();
let runRequestCount = 0;

// One process is one run. The test suite shares a process across runs, so the
// slot counters are cleared here too rather than carried into the next run.
export function resetRunState(): void {
  hosts.clear();
  runRequestCount = 0;
  requestsInFlight = 0;
  slotWaiters.length = 0;
}

function hostStateFor(origin: string): HostState {
  const existing = hosts.get(origin);
  if (existing) {
    return existing;
  }

  const state: HostState = {
    origin,
    queue: Promise.resolve(),
    lastRequestEndedAtMs: Number.NEGATIVE_INFINITY,
    delayMs: MIN_HOST_DELAY_MS,
    requestCount: 0,
    robots: null,
    robotsText: "",
    robotsLoaded: false,
  };
  hosts.set(origin, state);
  return state;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let requestsInFlight = 0;
const slotWaiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (requestsInFlight < MAX_REQUESTS_IN_FLIGHT) {
    requestsInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(): void {
  const waiter = slotWaiters.shift();
  if (waiter) {
    // Hand the slot straight over rather than releasing and re-counting it.
    waiter();
    return;
  }
  requestsInFlight -= 1;
}

// A robots.txt path rule one source is permitted to ignore, carrying the reason
// in the registry beside it. There is deliberately no global switch: an override
// reaches exactly the source that declares it, and covers path permission only,
// never the crawl delay, the per-host serialization, or the request budgets.
export interface RobotsOverride {
  reason: string;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  robotsOverride?: RobotsOverride;
}

type Attempt =
  | { ok: true; body: string }
  | { ok: false; retryable: boolean; status?: number; error: Error };

// A 4xx other than 429 describes the request itself, so repeating it produces
// the same answer and only costs the remote host another round trip.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function attempt(url: string, options: RequestOptions): Promise<Attempt> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers:
        options.body === undefined
          ? { "User-Agent": USER_AGENT }
          : {
              "User-Agent": USER_AGENT,
              "Content-Type": options.contentType ?? "application/json",
            },
      body: options.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, retryable: true, error: error as Error };
  }

  if (!response.ok) {
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      status: response.status,
      error: new Error(`${method} ${url} returned HTTP ${response.status}`),
    };
  }

  return { ok: true, body: await response.text() };
}

function spendBudget(state: HostState, url: string): void {
  if (state.requestCount >= MAX_REQUESTS_PER_HOST) {
    throw new RequestBudgetError(
      `${state.origin} has already taken ${MAX_REQUESTS_PER_HOST} requests this run, the per-host budget; GET ${url} was not sent`,
    );
  }
  if (runRequestCount >= MAX_REQUESTS_PER_RUN) {
    throw new RequestBudgetError(
      `This run has already sent ${MAX_REQUESTS_PER_RUN} requests, the whole-run budget; GET ${url} was not sent`,
    );
  }
  state.requestCount += 1;
  runRequestCount += 1;
}

async function politeAttempt(
  state: HostState,
  url: string,
  options: RequestOptions = {},
): Promise<Attempt> {
  spendBudget(state, url);

  // Reading the delay here rather than at the end of the previous request lets
  // a Crawl-delay learned from robots.txt cover the gap that follows it.
  const waitMs = state.lastRequestEndedAtMs + state.delayMs - Date.now();
  if (waitMs > 0) {
    await delay(waitMs);
  }

  await acquireSlot();
  try {
    return await attempt(url, options);
  } finally {
    // Measured from the end of one request so the quiet period is the full
    // delay whatever the host's response time.
    state.lastRequestEndedAtMs = Date.now();
    releaseSlot();
  }
}

async function fetchWithRetry(
  state: HostState,
  url: string,
  options: RequestOptions = {},
): Promise<Attempt> {
  const first = await politeAttempt(state, url, options);
  if (first.ok || !first.retryable) {
    return first;
  }
  return politeAttempt(state, url, options);
}

function crawlDelayMs(robots: Robots | null): number {
  const seconds = robots?.getCrawlDelay(USER_AGENT);
  if (seconds === undefined) {
    return MIN_HOST_DELAY_MS;
  }
  return Math.max(MIN_HOST_DELAY_MS, seconds * 1000);
}

async function loadRobots(state: HostState): Promise<void> {
  if (state.robotsLoaded) {
    return;
  }

  const robotsUrl = `${state.origin}/robots.txt`;
  const result = await fetchWithRetry(state, robotsUrl);

  if (!result.ok) {
    // A 4xx means the host publishes no rules, which grants the whole host. A
    // network failure or a 5xx leaves the rules unknown, and guessing at them
    // is the one thing this layer exists to prevent.
    const absent =
      result.status !== undefined &&
      result.status < 500 &&
      result.status !== 429;
    if (!absent) {
      throw new RobotsUnavailableError(
        `Cannot read robots.txt for ${state.origin}: ${result.error.message}`,
      );
    }
  }

  state.robotsText = result.ok ? result.body : "";
  state.robots = result.ok ? robotsParser(robotsUrl, result.body) : null;
  state.delayMs = crawlDelayMs(state.robots);
  state.robotsLoaded = true;
}

function ruleAtLine(robotsText: string, lineNumber: number): string {
  const lines = robotsText.split(/\r\n|\r|\n/);
  const line = lines[lineNumber - 1];
  return line === undefined ? "an unrecorded rule" : line.trim();
}

function assertAllowed(
  state: HostState,
  url: string,
  override: RobotsOverride | undefined,
): void {
  const robots = state.robots;
  // robots-parser answers true when no rule matches the path, and undefined
  // only for a URL belonging to another origin, which cannot reach this state.
  if (robots === null || robots.isAllowed(url, USER_AGENT) === true) {
    return;
  }

  const rule = ruleAtLine(
    state.robotsText,
    robots.getMatchingLineNumber(url, USER_AGENT),
  );

  if (override !== undefined) {
    // Announced on every run that uses one. An override nobody sees is an
    // override that becomes a habit.
    console.warn(
      `robots.txt at ${state.origin} forbids ${url} (rule: "${rule}"). Fetching anyway under an override recorded for this source: ${override.reason}`,
    );
    return;
  }

  throw new RobotsDisallowedError(
    `robots.txt at ${state.origin} forbids ${url} (rule: "${rule}"). This source is out of scope until the operator grants access.`,
  );
}

function enqueue<T>(state: HostState, task: () => Promise<T>): Promise<T> {
  const result = state.queue.then(task, task);
  // The chain outlives a failed task, and the copy it keeps is already handled.
  state.queue = result.catch(() => undefined);
  return result;
}

export async function fetchText(
  url: string,
  options: RequestOptions = {},
): Promise<string> {
  const state = hostStateFor(new URL(url).origin);

  return enqueue(state, async () => {
    await loadRobots(state);
    assertAllowed(state, url, options.robotsOverride);

    const result = await fetchWithRetry(state, url, options);
    if (!result.ok) {
      throw result.error;
    }
    return result.body;
  });
}
