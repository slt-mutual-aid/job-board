// Re-record the fixtures in scripts/sources/__fixtures__/bamboohr-vra with:
//
//   curl -sS -A 'SLT-MutualAid-JobBoard/1.0 (+https://github.com/slt-mutual-aid/job-board)' \
//     'https://vra.bamboohr.com/careers/list' \
//     -o scripts/sources/__fixtures__/bamboohr-vra/listing.json
//
//   curl -sS -A 'SLT-MutualAid-JobBoard/1.0 (+https://github.com/slt-mutual-aid/job-board)' \
//     'https://vra.bamboohr.com/careers/32/detail' \
//     -o scripts/sources/__fixtures__/bamboohr-vra/detail-32.json
//
// Update the fetchedAt timestamp in each accompanying .meta.json afterwards.

import { fetchText } from "../http";
import { htmlToPlainText } from "../text";
import { toIsoDate } from "../date";
import {
  SourceResponseError,
  type ListingResult,
  type ListingThenDetailAdapter,
  type SourcePosting,
} from "../types";

export interface BambooHrConfig {
  // The BambooHR account subdomain, as it appears in the careers host.
  subdomain: string;
  // Matched against location.city as an exact string. The listing carries the
  // whole company, including Truckee and North Lake Tahoe.
  city: string;
}

// The fields the listing carries. Description, posting date, and status arrive
// only from the detail endpoint.
export interface BambooHrListingEntry {
  id: string;
  title: string;
  department: string;
  commitment: string;
  city: string;
  state: string;
}

const OPEN_STATUS = "Open";

export class BambooHrResponseError extends SourceResponseError {
  constructor(message: string) {
    super(message);
    this.name = "BambooHrResponseError";
  }
}

export function listingUrl(config: BambooHrConfig): string {
  return `https://${config.subdomain}.bamboohr.com/careers/list`;
}

export function detailUrl(
  config: BambooHrConfig,
  entry: BambooHrListingEntry,
): string {
  return `https://${config.subdomain}.bamboohr.com/careers/${entry.id}/detail`;
}

export async function fetchListingRaw(config: BambooHrConfig): Promise<string> {
  return fetchText(listingUrl(config));
}

export async function fetchDetailRaw(
  config: BambooHrConfig,
  entry: BambooHrListingEntry,
): Promise<string> {
  return fetchText(detailUrl(config, entry));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decode(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new BambooHrResponseError(
      `Response is not JSON: ${(error as Error).message}`,
    );
  }
}

function requireObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new BambooHrResponseError(`Response has no ${description}`);
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
    throw new BambooHrResponseError(`${where} has no string "${field}"`);
  }
  return value;
}

// BambooHR writes the listing id as a string and the detail endpoint takes it
// back verbatim, so a number here would mean the identifier changed shape.
function toListingEntry(entry: unknown, index: number): BambooHrListingEntry {
  const where = `Posting at index ${index}`;
  const container = requireObject(entry, `object at result index ${index}`);
  const location = requireObject(
    container.location,
    `"location" object at result index ${index}`,
  );

  return {
    id: requireString(container, "id", where),
    title: requireString(container, "jobOpeningName", where),
    department: requireString(container, "departmentLabel", where),
    commitment: requireString(container, "employmentStatusLabel", where),
    city: requireString(location, "city", where),
    state: requireString(location, "state", where),
  };
}

export function parseListing(raw: string): ListingResult<BambooHrListingEntry> {
  const decoded = decode(raw);
  if (!isObject(decoded)) {
    throw new BambooHrResponseError(
      `Response is ${Array.isArray(decoded) ? "an array" : typeof decoded}, expected a listing object`,
    );
  }

  const meta = requireObject(decoded.meta, '"meta" object');
  const totalCount = meta.totalCount;
  if (typeof totalCount !== "number" || !Number.isFinite(totalCount)) {
    throw new BambooHrResponseError('Response has no number "meta.totalCount"');
  }

  const result = decoded.result;
  if (!Array.isArray(result)) {
    throw new BambooHrResponseError('Response has no "result" array');
  }

  return {
    entries: result.map(toListingEntry),
    // The total is the source's own count, so agreement with the entries is
    // what separates a genuinely empty day from a listing that lost its rows.
    confirmedEmpty: totalCount === 0 && result.length === 0,
  };
}

export function selectLocal(
  entries: BambooHrListingEntry[],
  config: BambooHrConfig,
): BambooHrListingEntry[] {
  return entries.filter((entry) => entry.city === config.city);
}

export function parseDetail(
  raw: string,
  entry: BambooHrListingEntry,
): SourcePosting {
  const decoded = decode(raw);
  const result = requireObject(
    isObject(decoded) ? decoded.result : undefined,
    '"result" object',
  );
  const opening = requireObject(
    result.jobOpening,
    '"result.jobOpening" object',
  );
  const where = `Posting ${entry.id}`;
  const status = requireString(opening, "jobOpeningStatus", where);

  return {
    id: entry.id,
    title: entry.title,
    department: entry.department,
    location: `${entry.city}, ${entry.state}`,
    applyLink: requireString(opening, "jobOpeningShareUrl", where),
    // datePosted carries a calendar date and no time of day.
    postedAt: toIsoDate(requireString(opening, "datePosted", where)),
    commitment: entry.commitment,
    description: htmlToPlainText(requireString(opening, "description", where)),
    liveness: { status, isOpen: status === OPEN_STATUS },
  };
}

export const bambooHrAdapter: ListingThenDetailAdapter<
  BambooHrConfig,
  BambooHrListingEntry
> = {
  id: "bamboohr",
  shape: "listing-then-detail",
  listingUrl,
  fetchListingRaw,
  parseListing,
  selectLocal,
  detailUrl,
  fetchDetailRaw,
  parseDetail,
};
