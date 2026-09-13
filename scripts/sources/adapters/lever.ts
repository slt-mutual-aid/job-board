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

export interface LeverConfig {
  // The Lever account slug, as it appears in the posting API path.
  company: string;
  // Matched against categories.location as an exact string, both by the Lever
  // server filter and again locally.
  location: string;
}

export interface LeverPosting {
  id: string;
  title: string;
  location: string;
  applyLink: string;
  postedDate?: string;
  commitment?: string;
  description?: string;
}

export interface LeverParseResult {
  postings: LeverPosting[];
  // True only when the response was a well-formed, genuinely empty array. A
  // caller can then tell a quiet day from a parse that lost every posting.
  confirmedEmpty: boolean;
}

export class LeverResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeverResponseError";
  }
}

interface RawPosting {
  id: string;
  text: string;
  hostedUrl: string;
  categories: { location: string; commitment?: unknown };
  createdAt?: unknown;
  descriptionPlain?: unknown;
}

export function buildUrl(config: LeverConfig): string {
  // URLSearchParams writes a space as a plus sign. The location filter is an
  // exact string match and is only verified against percent-encoded spaces.
  const location = encodeURIComponent(config.location);
  return `https://api.lever.co/v0/postings/${config.company}?mode=json&location=${location}`;
}

export async function fetchRaw(config: LeverConfig): Promise<string> {
  return fetchText(buildUrl(config));
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function toRawPosting(entry: unknown, index: number): RawPosting {
  if (!isObject(entry)) {
    throw new LeverResponseError(`Posting at index ${index} is not an object`);
  }

  const categories = entry.categories;
  if (!isObject(categories)) {
    throw new LeverResponseError(
      `Posting at index ${index} has no "categories" object`,
    );
  }

  return {
    id: requireString(entry, "id", index),
    text: requireString(entry, "text", index),
    hostedUrl: requireString(entry, "hostedUrl", index),
    categories: {
      location: requireString(categories, "location", index),
      commitment: categories.commitment,
    },
    createdAt: entry.createdAt,
    descriptionPlain: entry.descriptionPlain,
  };
}

// Lever reports createdAt in epoch milliseconds. Local-time getters would shift
// the date by a day for anyone west of UTC.
function toPostedDate(createdAt: unknown): string | undefined {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return undefined;
  }
  const date = new Date(createdAt);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toPosting(raw: RawPosting): LeverPosting {
  return {
    id: raw.id,
    title: raw.text,
    location: raw.categories.location,
    // hostedUrl is the public posting page. applyUrl is the application form.
    applyLink: raw.hostedUrl,
    postedDate: toPostedDate(raw.createdAt),
    commitment: optionalString(raw.categories.commitment),
    description: optionalString(raw.descriptionPlain),
  };
}

export function parse(raw: string, config: LeverConfig): LeverParseResult {
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

  const rawPostings = decoded.map(toRawPosting);

  // The server already filters on location. Re-asserting it locally catches a
  // filter that stops matching without failing.
  const postings = rawPostings
    .filter((posting) => posting.categories.location === config.location)
    .map(toPosting);

  return { postings, confirmedEmpty: decoded.length === 0 };
}
