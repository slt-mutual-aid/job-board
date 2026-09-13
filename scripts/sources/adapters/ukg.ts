// Re-record the fixtures in scripts/sources/__fixtures__/ukg-ballys with:
//
//   curl -sS -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     -H 'Content-Type: application/json' \
//     --data '{"opportunitySearch":{"Top":50,"Skip":0,"QueryString":"","OrderBy":[{"Value":"postedDateDesc","PropertyName":"PostedDate","Ascending":false}],"Filters":[]}}' \
//     'https://recruiting.ultipro.com/TWI1006TRWH/JobBoard/b9cc79c4-75a2-4800-8508-16504f7a2d90/JobBoardView/LoadSearchResults' \
//     -o scripts/sources/__fixtures__/ukg-ballys/page-0.json
//
// page-1.json and page-2.json take the same request with a Skip of 50 and 100.
// empty.json takes a Skip of 0 and a QueryString of "Stateline", which the
// endpoint matches against titles and answers with a total of zero.
//
// Update the fetchedAt timestamp in each accompanying .meta.json afterwards.

import { fetchText, type RobotsOverride } from "../http";
import { toIsoDate } from "../date";
import {
  SourceResponseError,
  type ListingOnlyAdapter,
  type ListingResult,
  type SourcePosting,
} from "../types";

// The endpoint takes Top and Skip and reports the whole total on every page.
// Fifty is the page size the job board's own search uses.
export const PAGE_SIZE = 50;

// Bally's publishes about 412 postings, which is nine requests. The ceiling
// turns a total the endpoint reports wrongly into a throw rather than a run
// that spends the per-host budget in http.ts.
export const MAX_PAGES = 20;

// A posting can carry more than one location, and the location rule has to see
// every one of them, so the field holds them all and selectLocal matches a
// whole segment rather than a substring.
const LOCATION_SEPARATOR = "; ";

const FULL_TIME = "Full Time";

// The board this employer publishes under. The search response carries a
// posting identifier and no link, so the public posting page is built from the
// path the pages were fetched from.
export interface UkgBoard {
  // The UKG tenant code, as it appears in the job board path.
  tenant: string;
  // The job board identifier, as it appears in the job board path.
  jobBoardId: string;
}

export interface UkgConfig extends UkgBoard {
  // Matched against Address.City as an exact string. Bally's is national, and a
  // looser rule puts Biloxi and Atlantic City on a South Lake Tahoe board.
  city: string;
  // Matched against Address.State.Code.
  state: string;
  // recruiting.ultipro.com forbids the search path. The registry entry carries
  // the reason the operator reads it anyway.
  robotsOverride: RobotsOverride;
}

export class UkgResponseError extends SourceResponseError {
  constructor(message: string) {
    super(message);
    this.name = "UkgResponseError";
  }
}

export function listingUrl(config: UkgConfig): string {
  return `https://recruiting.ultipro.com/${config.tenant}/JobBoard/${config.jobBoardId}/JobBoardView/LoadSearchResults`;
}

export function opportunityUrl(board: UkgBoard, id: string): string {
  return `https://recruiting.ultipro.com/${board.tenant}/JobBoard/${board.jobBoardId}/OpportunityDetail?opportunityId=${id}`;
}

// No server-side location filter works on this endpoint: a QueryString is
// matched against titles, a LocationSearch is ignored, and a Filters entry
// naming a city answers HTTP 500. The whole company is read and filtered here.
function searchBody(skip: number): string {
  return JSON.stringify({
    opportunitySearch: {
      Top: PAGE_SIZE,
      Skip: skip,
      QueryString: "",
      OrderBy: [
        {
          Value: "postedDateDesc",
          PropertyName: "PostedDate",
          Ascending: false,
        },
      ],
      Filters: [],
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decode(raw: string, description: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UkgResponseError(
      `${description} is not JSON: ${(error as Error).message}`,
    );
  }
}

function requireObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new UkgResponseError(`Response has no ${description}`);
  }
  return value;
}

function requireString(
  container: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = container[field];
  if (typeof value !== "string" || value === "") {
    throw new UkgResponseError(`${where} has no string "${field}"`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function totalCountOf(page: Record<string, unknown>, where: string): number {
  const value = page.totalCount;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new UkgResponseError(`${where} has no number "totalCount"`);
  }
  return value;
}

// The pages of one reading, kept as the bodies the endpoint returned so every
// parse of a response happens in parseListing, where a recorded fixture reaches
// it. The board travels with them because the posting link is built from the
// path rather than read out of the body.
export function toPagedListing(
  board: UkgBoard,
  pages: readonly string[],
): string {
  return JSON.stringify({ board, pages });
}

async function fetchPage(config: UkgConfig, skip: number): Promise<string> {
  return fetchText(listingUrl(config), {
    method: "POST",
    body: searchBody(skip),
    contentType: "application/json",
    robotsOverride: config.robotsOverride,
  });
}

// A page that fails after the retry in http.ts takes the whole reading with it,
// because a listing short one page is indistinguishable from an employer that
// withdrew the postings on it. The throw reaches the health rules as a failure,
// which carries neither a count nor any postings.
export async function fetchListingRaw(config: UkgConfig): Promise<string> {
  const pages: string[] = [];
  let total: number | null = null;

  while (total === null || pages.length * PAGE_SIZE < total) {
    if (pages.length >= MAX_PAGES) {
      throw new UkgResponseError(
        `Reading ${listingUrl(config)} reached ${MAX_PAGES} pages without covering the reported total of ${total}`,
      );
    }

    const raw = await fetchPage(config, pages.length * PAGE_SIZE);
    pages.push(raw);

    const where = `Page ${pages.length}`;
    const pageTotal = totalCountOf(
      requireObject(decode(raw, where), `object in ${where.toLowerCase()}`),
      where,
    );
    if (total === null) {
      total = pageTotal;
    } else if (pageTotal !== total) {
      // The pages would then belong to two different listings, and a posting
      // could sit either side of the shift without appearing in the reading.
      throw new UkgResponseError(
        `${where} reports a total of ${pageTotal} where the first page reported ${total}; the listing changed while it was being read`,
      );
    }
  }

  return toPagedListing(config, pages);
}

// The count a page carries once the total is known. Every page but the last is
// full, so a page that comes back short is a page that lost postings.
function expectedPageSize(total: number, index: number): number {
  return Math.min(PAGE_SIZE, Math.max(0, total - index * PAGE_SIZE));
}

function formatLocation(
  address: Record<string, unknown>,
  where: string,
): string {
  const city = requireString(address, "City", where);
  const state = address.State;
  if (!isObject(state)) {
    // A location outside the United States carries no state, and the city alone
    // is what the address then says.
    return city;
  }
  return `${city}, ${requireString(state, "Code", where)}`;
}

function locationsOf(
  opportunity: Record<string, unknown>,
  where: string,
): string {
  const locations = opportunity.Locations;
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new UkgResponseError(`${where} has no "Locations" entries`);
  }

  const formatted: string[] = [];
  for (const location of locations) {
    const address = requireObject(
      isObject(location) ? location.Address : undefined,
      `"Address" object in a location of ${where.toLowerCase()}`,
    );
    const value = formatLocation(address, where);
    if (!formatted.includes(value)) {
      formatted.push(value);
    }
  }
  return formatted.join(LOCATION_SEPARATOR);
}

// A false FullTime covers the postings titled "(Part Time)" and the ones titled
// "(On-Call)" alike, so it produces no commitment rather than a "Part Time" the
// employer never published.
function commitmentOf(
  opportunity: Record<string, unknown>,
  where: string,
): string | undefined {
  const fullTime = opportunity.FullTime;
  if (typeof fullTime !== "boolean") {
    throw new UkgResponseError(`${where} has no boolean "FullTime"`);
  }
  return fullTime ? FULL_TIME : undefined;
}

function toPosting(
  value: unknown,
  board: UkgBoard,
  where: string,
): SourcePosting {
  const opportunity = requireObject(value, `object at ${where.toLowerCase()}`);
  const id = requireString(opportunity, "Id", where);

  // liveness stays absent: the search publishes no open or closed signal, and
  // an open posting is the one thing an unchecked posting must not claim to be.
  return {
    id,
    title: requireString(opportunity, "Title", where),
    location: locationsOf(opportunity, where),
    applyLink: opportunityUrl(board, id),
    postedAt: toIsoDate(requireString(opportunity, "PostedDate", where)),
    commitment: commitmentOf(opportunity, where),
    // A posting missing a category or a summary is still a posting a job
    // seeker can read, so neither field stops the reading.
    department: optionalString(opportunity.JobCategoryName),
    description: optionalString(opportunity.BriefDescription),
  };
}

function requireBoard(value: unknown): UkgBoard {
  const board = requireObject(value, '"board" object');
  return {
    tenant: requireString(board, "tenant", "The board"),
    jobBoardId: requireString(board, "jobBoardId", "The board"),
  };
}

export function parseListing(raw: string): ListingResult<SourcePosting> {
  const listing = requireObject(decode(raw, "The reading"), "pages to read");
  const board = requireBoard(listing.board);

  const pages = listing.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new UkgResponseError('Response has no "pages" array');
  }

  const entries: SourcePosting[] = [];
  let total: number | null = null;

  for (const [index, page] of pages.entries()) {
    const where = `Page ${index + 1}`;
    if (typeof page !== "string") {
      throw new UkgResponseError(`${where} is not a recorded response body`);
    }

    const decoded = requireObject(
      decode(page, where),
      `object in ${where.toLowerCase()}`,
    );
    const pageTotal = totalCountOf(decoded, where);
    if (total === null) {
      total = pageTotal;
    } else if (pageTotal !== total) {
      throw new UkgResponseError(
        `${where} reports a total of ${pageTotal} where the first page reported ${total}`,
      );
    }

    const opportunities = decoded.opportunities;
    if (!Array.isArray(opportunities)) {
      throw new UkgResponseError(`${where} has no "opportunities" array`);
    }

    // The total the source reports about itself is the canary. A page that
    // agrees with neither the page size nor the remainder of the total lost
    // postings on the way, and the count it produces is one nothing downstream
    // may read as an employer with fewer openings.
    const expected = expectedPageSize(pageTotal, index);
    if (opportunities.length !== expected) {
      throw new UkgResponseError(
        `${where} carries ${opportunities.length} opportunities where a total of ${pageTotal} makes it ${expected}`,
      );
    }

    for (const [position, opportunity] of opportunities.entries()) {
      entries.push(toPosting(opportunity, board, `${where} index ${position}`));
    }
  }

  // An empty listing still answers with one page, so a total of zero over more
  // pages than it can fill means the pages were not one reading.
  const maxPages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));
  if (pages.length > maxPages) {
    throw new UkgResponseError(
      `The reading carries ${pages.length} pages where a total of ${total} fills ${maxPages}`,
    );
  }

  return {
    entries,
    confirmedEmpty: total === 0 && entries.length === 0,
  };
}

export function selectLocal(
  entries: SourcePosting[],
  config: UkgConfig,
): SourcePosting[] {
  const target = `${config.city}, ${config.state}`;
  return entries.filter((entry) =>
    entry.location.split(LOCATION_SEPARATOR).includes(target),
  );
}

export const ukgAdapter: ListingOnlyAdapter<UkgConfig> = {
  id: "ukg",
  shape: "listing-only",
  listingUrl,
  fetchListingRaw,
  parseListing,
  selectLocal,
};
