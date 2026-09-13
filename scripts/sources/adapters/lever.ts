// Re-record the fixtures in scripts/sources/__fixtures__/lever-insomnia with:
//
//   curl -sS -A 'SLT-MutualAid-JobBoard/1.0 (+https://github.com/slt-mutual-aid/job-board)' \
//     'https://api.lever.co/v0/postings/insomniacookies?mode=json&location=South%20Lake%20Tahoe%20CA' \
//     -o scripts/sources/__fixtures__/lever-insomnia/listing.json
//
//   curl -sS -A 'SLT-MutualAid-JobBoard/1.0 (+https://github.com/slt-mutual-aid/job-board)' \
//     'https://api.lever.co/v0/postings/insomniacookies?mode=json&location=South%20Lake%20Tahoe' \
//     -o scripts/sources/__fixtures__/lever-insomnia/empty.json
//
// Update the fetchedAt timestamp in each accompanying .meta.json afterwards.

import { fetchText } from "../http";
import { toIsoDateFromEpochMs } from "../date";
import {
  SourceResponseError,
  type ListingOnlyAdapter,
  type ListingResult,
  type SourcePosting,
} from "../types";

export interface LeverConfig {
  // The Lever account slug, as it appears in the posting API path.
  company: string;
  // Matched against categories.location as an exact string, both by the Lever
  // server filter and again locally.
  location: string;
}

export class LeverResponseError extends SourceResponseError {
  constructor(message: string) {
    super(message);
    this.name = "LeverResponseError";
  }
}

export function listingUrl(config: LeverConfig): string {
  // URLSearchParams writes a space as a plus sign. The location filter is an
  // exact string match and is only verified against percent-encoded spaces.
  const location = encodeURIComponent(config.location);
  return `https://api.lever.co/v0/postings/${config.company}?mode=json&location=${location}`;
}

export async function fetchListingRaw(config: LeverConfig): Promise<string> {
  return fetchText(listingUrl(config));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  container: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = container[field];
  if (typeof value !== "string" || value === "") {
    throw new LeverResponseError(
      `Posting at index ${index} has no string "${field}"`,
    );
  }
  return value;
}

function requireNumber(
  container: Record<string, unknown>,
  field: string,
  index: number,
): number {
  const value = container[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LeverResponseError(
      `Posting at index ${index} has no number "${field}"`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function toPosting(entry: unknown, index: number): SourcePosting {
  if (!isObject(entry)) {
    throw new LeverResponseError(`Posting at index ${index} is not an object`);
  }

  const categories = entry.categories;
  if (!isObject(categories)) {
    throw new LeverResponseError(
      `Posting at index ${index} has no "categories" object`,
    );
  }

  // liveness stays absent: Lever publishes no open or closed signal, and an
  // open posting is the one thing an unchecked posting must not claim to be.
  return {
    id: requireString(entry, "id", index),
    title: requireString(entry, "text", index),
    location: requireString(categories, "location", index),
    // hostedUrl is the public posting page. applyUrl is the application form.
    applyLink: requireString(entry, "hostedUrl", index),
    // Lever reports createdAt in epoch milliseconds.
    postedAt: toIsoDateFromEpochMs(requireNumber(entry, "createdAt", index)),
    commitment: optionalString(categories.commitment),
    description: optionalString(entry.descriptionPlain),
  };
}

export function parseListing(raw: string): ListingResult<SourcePosting> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new LeverResponseError(
      `Response is not JSON: ${(error as Error).message}`,
    );
  }

  if (!Array.isArray(decoded)) {
    throw new LeverResponseError(
      `Response is ${typeof decoded}, expected an array of postings`,
    );
  }

  return {
    entries: decoded.map(toPosting),
    confirmedEmpty: decoded.length === 0,
  };
}

// The server already filters on location. Re-asserting it locally catches a
// filter that stops matching without failing.
export function selectLocal(
  entries: SourcePosting[],
  config: LeverConfig,
): SourcePosting[] {
  return entries.filter((entry) => entry.location === config.location);
}

export const leverAdapter: ListingOnlyAdapter<LeverConfig> = {
  id: "lever",
  shape: "listing-only",
  listingUrl,
  fetchListingRaw,
  parseListing,
  selectLocal,
};
