import { readFileSync } from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchText,
  resetRunState,
  RequestBudgetError,
  RobotsDisallowedError,
  RobotsUnavailableError,
} from "./http";

// Recorded from the live hosts; see the .meta.json beside each file for the URL
// and the time of the fetch.
function robotsFixture(host: string): string {
  return readFileSync(
    new URL(`./__fixtures__/robots/${host}.txt`, import.meta.url),
    "utf-8",
  );
}

const RECORDED_ROBOTS: Record<string, string> = {
  "recruiting.ultipro.com": robotsFixture("recruiting.ultipro.com"),
  "www.governmentjobs.com": robotsFixture("www.governmentjobs.com"),
  "savemart.csod.com": robotsFixture("savemart.csod.com"),
  "api.lever.co": robotsFixture("api.lever.co"),
};

const ULTIPRO_URL =
  "https://recruiting.ultipro.com/TWI1006TRWH/JobBoard/b9cc79c4-75a2-4800-8508-16504f7a2d90/JobBoardView/LoadSearchResults";
const GOVERNMENTJOBS_URL = "https://www.governmentjobs.com/careers/slaketahoe";
const SAVEMART_URL = "https://savemart.csod.com/ux/ats/careersite/4/home";
const LEVER_URL =
  "https://api.lever.co/v0/postings/insomniacookies?mode=json&location=South%20Lake%20Tahoe%20CA";

interface Sent {
  url: string;
  atMs: number;
}

let sent: Sent[];
let respond: (url: string) => Response | Promise<Response>;

function body(text: string, status = 200): Response {
  return new Response(text, { status });
}

// A host absent from the recording publishes no robots.txt, which is the shape
// every test that is not about a specific recorded host wants.
function defaultRespond(url: string): Response {
  const parsed = new URL(url);
  if (parsed.pathname === "/robots.txt") {
    const recorded = RECORDED_ROBOTS[parsed.host];
    return recorded === undefined ? body("", 404) : body(recorded);
  }
  return body(`payload from ${parsed.pathname}`);
}

function dataRequests(): Sent[] {
  return sent.filter((request) => !request.url.endsWith("/robots.txt"));
}

// Fake timers hold the clock still until a test advances it, so the waits this
// module schedules cost the suite nothing.
async function settled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  resetRunState();
  sent = [];
  respond = defaultRespond;
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      sent.push({ url: String(url), atMs: Date.now() });
      return Promise.resolve(respond(String(url)));
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("robots.txt verdicts recorded from the live hosts", () => {
  it("refuses the UltiPro board view that Disallow: */JobBoardView covers", async () => {
    await expect(settled(fetchText(ULTIPRO_URL))).rejects.toThrow(
      RobotsDisallowedError,
    );

    expect(dataRequests()).toEqual([]);
  });

  it("names the host and the rule that forbids the UltiPro board view", async () => {
    await expect(settled(fetchText(ULTIPRO_URL))).rejects.toThrow(
      /recruiting\.ultipro\.com.*Disallow: \*\/JobBoardView/s,
    );
  });

  it("refuses the GovernmentJobs career site that Disallow: / covers", async () => {
    await expect(settled(fetchText(GOVERNMENTJOBS_URL))).rejects.toThrow(
      /www\.governmentjobs\.com.*Disallow: \//s,
    );

    expect(dataRequests()).toEqual([]);
  });

  it("allows the Save Mart career site and waits out its Crawl-delay of 10", async () => {
    await settled(fetchText(SAVEMART_URL));
    await settled(fetchText(SAVEMART_URL));

    expect(dataRequests().map((request) => request.atMs)).toEqual([
      10_000, 20_000,
    ]);
  });

  it("allows the Lever posting API and waits out its Crawl-delay of 1", async () => {
    await settled(fetchText(LEVER_URL));
    await settled(fetchText(LEVER_URL));

    expect(dataRequests().map((request) => request.atMs)).toEqual([1000, 2000]);
  });
});

describe("robots.txt handling", () => {
  it("reads robots.txt once per host per run", async () => {
    await settled(fetchText(LEVER_URL));
    await settled(fetchText(LEVER_URL));

    expect(
      sent.filter((request) => request.url.endsWith("/robots.txt")),
    ).toHaveLength(1);
  });

  it("refuses to guess when robots.txt is unreadable", async () => {
    respond = (url) =>
      url.endsWith("/robots.txt") ? body("", 500) : body("payload");

    await expect(settled(fetchText(LEVER_URL))).rejects.toThrow(
      RobotsUnavailableError,
    );

    expect(dataRequests()).toEqual([]);
  });

  it("treats a host with no robots.txt as open at the floor delay", async () => {
    await expect(settled(fetchText("https://careers.example/a"))).resolves.toBe(
      "payload from /a",
    );
    await settled(fetchText("https://careers.example/b"));

    expect(dataRequests().map((request) => request.atMs)).toEqual([1000, 2000]);
  });
});

describe("per-host rate limiting", () => {
  it("serializes concurrent requests to one host", async () => {
    const both = Promise.all([
      fetchText("https://api.lever.co/v0/postings/a"),
      fetchText("https://api.lever.co/v0/postings/b"),
    ]);

    await settled(both);

    expect(sent.map((request) => request.atMs)).toEqual([0, 1000, 2000]);
  });

  it("waits out the host delay before a retry", async () => {
    let served = 0;
    respond = (url) => {
      if (url.endsWith("/robots.txt")) {
        return body(RECORDED_ROBOTS["api.lever.co"]);
      }
      served += 1;
      return served === 1 ? body("", 503) : body("payload");
    };

    await expect(settled(fetchText(LEVER_URL))).resolves.toBe("payload");

    expect(dataRequests().map((request) => request.atMs)).toEqual([1000, 2000]);
  });

  it("does not retry a status that describes the request itself", async () => {
    respond = (url) =>
      url.endsWith("/robots.txt")
        ? body(RECORDED_ROBOTS["api.lever.co"])
        : body("", 404);

    await expect(settled(fetchText(LEVER_URL))).rejects.toThrow(/HTTP 404/);

    expect(dataRequests()).toHaveLength(1);
  });

  it("runs no more than two requests at once across hosts", async () => {
    const release: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    respond = (url) => {
      if (url.endsWith("/robots.txt")) {
        return body("", 404);
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<Response>((resolve) => {
        release.push(() => {
          inFlight -= 1;
          resolve(body("payload"));
        });
      });
    };

    const all = Promise.all([
      fetchText("https://one.example/jobs"),
      fetchText("https://two.example/jobs"),
      fetchText("https://three.example/jobs"),
    ]);
    all.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1000);
    expect(peak).toBe(2);
    expect(dataRequests()).toHaveLength(2);

    while (release.length > 0) {
      release.shift()?.();
      await vi.runAllTimersAsync();
    }

    await expect(all).resolves.toEqual(["payload", "payload", "payload"]);
    expect(peak).toBe(2);
  });
});

describe("per-run request budgets", () => {
  it("stops at 40 requests to one host", async () => {
    // The robots.txt read is the first of the host's 40.
    for (let index = 0; index < 39; index += 1) {
      await settled(fetchText(`https://api.lever.co/v0/postings/${index}`));
    }

    await expect(
      settled(fetchText("https://api.lever.co/v0/postings/last")),
    ).rejects.toThrow(RequestBudgetError);

    expect(sent).toHaveLength(40);
  });

  it("stops at 200 requests across the run", async () => {
    for (const host of ["a", "b", "c", "d", "e"]) {
      for (let index = 0; index < 39; index += 1) {
        await settled(fetchText(`https://${host}.example/jobs/${index}`));
      }
    }

    await expect(
      settled(fetchText("https://f.example/jobs/0")),
    ).rejects.toThrow(/whole-run budget/);

    expect(sent).toHaveLength(200);
  });
});
