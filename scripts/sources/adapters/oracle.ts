// Re-record the fixtures in scripts/sources/__fixtures__/oracle-caesars and
// scripts/sources/__fixtures__/oracle-raleys with:
//
//   curl -sS --compressed -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://edmn.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_1,limit=200,sortBy=POSTING_DATES_DESC,selectedLocationsFacet=300000002323814' \
//     -o scripts/sources/__fixtures__/oracle-caesars/listing.json
//
//   curl -sS --compressed -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://edmn.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_1,limit=200,sortBy=POSTING_DATES_DESC,selectedLocationsFacet=1' \
//     -o scripts/sources/__fixtures__/oracle-caesars/empty.json
//
//   curl -sS --compressed -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://fa-epss-saasfaprod1.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_1,limit=200,sortBy=POSTING_DATES_DESC,selectedLocationsFacet=300000002154145' \
//     -o scripts/sources/__fixtures__/oracle-raleys/listing.json
//
//   curl -sS --compressed -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://fa-epss-saasfaprod1.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_1,limit=200,sortBy=POSTING_DATES_DESC,selectedLocationsFacet=1' \
//     -o scripts/sources/__fixtures__/oracle-raleys/empty.json
//
// --compressed matters: the host compresses the body whatever the request asks
// for, and a fixture holding the compressed bytes parses as nothing.
// selectedLocationsFacet=1 names no location, which is how a well-formed
// response carrying nothing gets recorded without waiting for a quiet week.
//
// Update the fetchedAt timestamp in each accompanying .meta.json afterwards.

import { fetchText } from "../http";
import { toIsoDate } from "../date";
import {
  SourceResponseError,
  type ListingOnlyAdapter,
  type ListingResult,
  type SourcePosting,
} from "../types";

// One page holds every posting at the location, so the whole listing arrives in
// one request and parseListing can hold the count to the source's own total.
// Caesar's Entertainment listed 73 at Stateline in September 2026.
const PAGE_LIMIT = 200;

export interface OracleConfig {
  // The employer's Oracle HCM Cloud host, as it appears in the career site URL.
  host: string;
  // The candidate experience site on that host. CX_1 is the external site both
  // employers publish, and the id is part of every posting page path.
  siteNumber: string;
  // The numeric id Oracle gives the location facet. The server filters on it,
  // and it does not appear in the requisition fields.
  locationFacet: string;
  // Matched against PrimaryLocation as an exact string. The facet is wider than
  // the town: the Stateline facet also carries a Reno posting.
  location: string;
}

export class OracleResponseError extends SourceResponseError {
  constructor(message: string) {
    super(message);
    this.name = "OracleResponseError";
  }
}

export function listingUrl(config: OracleConfig): string {
  // The finder value keeps its semicolon and commas: Oracle reads them as the
  // finder's own separators, and a percent-encoded one returns every location.
  const finder = [
    `findReqs;siteNumber=${config.siteNumber}`,
    `limit=${PAGE_LIMIT}`,
    "sortBy=POSTING_DATES_DESC",
    `selectedLocationsFacet=${config.locationFacet}`,
  ].join(",");
  return `https://${config.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=${finder}`;
}

// The page a job seeker reads, which is also the link shape the board already
// carries for this employer.
export function postingUrl(config: OracleConfig, id: string): string {
  return `https://${config.host}/hcmUI/CandidateExperience/en/sites/${config.siteNumber}/job/${id}/`;
}

export async function fetchListingRaw(config: OracleConfig): Promise<string> {
  return fetchText(listingUrl(config));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  container: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = container[field];
  if (typeof value !== "string" || value === "") {
    throw new OracleResponseError(`${where} has no string "${field}"`);
  }
  return value;
}

// Oracle writes an absent closing date as null rather than omitting the field.
// A value date.ts cannot read leaves the column empty, which is what the board
// already holds for every row, rather than failing a run over one posting.
function optionalIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const isoDate = toIsoDate(value);
  return isoDate === "" ? undefined : isoDate;
}

function toPosting(
  entry: unknown,
  index: number,
  config: OracleConfig,
): SourcePosting {
  const where = `Requisition at index ${index}`;
  if (!isObject(entry)) {
    throw new OracleResponseError(`${where} is not an object`);
  }

  const id = requireString(entry, "Id", where);

  // liveness stays absent: the listing carries no open or closed field, and a
  // posting nothing checked must not claim to be open.
  // description stays absent: ShortDescriptionStr is empty on every requisition
  // both employers publish, and the text lives on a per-posting detail request.
  // Caesar's lists 73 postings and http.ts allows one host 40 requests a run,
  // so the detail requests alone would stop the run part way through.
  return {
    id,
    title: requireString(entry, "Title", where),
    location: requireString(entry, "PrimaryLocation", where),
    applyLink: postingUrl(config, id),
    // PostedDate carries a calendar date and no time of day.
    postedAt: toIsoDate(requireString(entry, "PostedDate", where)),
    closesAt: optionalIsoDate(entry.PostingEndDate),
  };
}

function parseListingFor(
  raw: string,
  config: OracleConfig,
): ListingResult<SourcePosting> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new OracleResponseError(
      `Response is not JSON: ${(error as Error).message}`,
    );
  }

  if (!isObject(decoded) || !Array.isArray(decoded.items)) {
    throw new OracleResponseError('Response has no "items" array');
  }

  // The endpoint answers one search with one result object. Any other number
  // means the envelope changed and the requisitions below it are not where this
  // parser is looking.
  if (decoded.items.length !== 1) {
    throw new OracleResponseError(
      `Response carries ${decoded.items.length} search results, expected 1`,
    );
  }

  const search: unknown = decoded.items[0];
  if (!isObject(search)) {
    throw new OracleResponseError("Response item 0 is not an object");
  }

  const totalJobsCount = search.TotalJobsCount;
  if (
    typeof totalJobsCount !== "number" ||
    !Number.isInteger(totalJobsCount) ||
    totalJobsCount < 0
  ) {
    throw new OracleResponseError(
      'Response has no whole number "TotalJobsCount"',
    );
  }

  const requisitions = search.requisitionList;
  if (!Array.isArray(requisitions)) {
    throw new OracleResponseError('Response has no "requisitionList" array');
  }

  // The source states how many postings match, so a listing that hands back a
  // different number is either a page cut short by PAGE_LIMIT or a response
  // whose shape moved. Both make a live posting look withdrawn to the
  // reconciliation report, so neither is read as a result.
  if (requisitions.length !== totalJobsCount) {
    throw new OracleResponseError(
      `Response carries ${requisitions.length} requisitions and reports TotalJobsCount ${totalJobsCount}. Raise PAGE_LIMIT above ${PAGE_LIMIT} if the employer now posts more than one page.`,
    );
  }

  return {
    entries: requisitions.map((entry, index) =>
      toPosting(entry, index, config),
    ),
    confirmedEmpty: totalJobsCount === 0,
  };
}

// The server already filters on the location facet. Re-asserting the location
// locally drops the neighbouring towns the facet carries anyway.
export function selectLocal(
  entries: SourcePosting[],
  config: OracleConfig,
): SourcePosting[] {
  return entries.filter((entry) => entry.location === config.location);
}

// A requisition carries no posting URL, so parseListing builds the apply link
// from the host the response came from. The contract hands parseListing no
// config, so each employer gets an adapter holding the config it was read with.
export function createOracleAdapter(
  config: OracleConfig,
): ListingOnlyAdapter<OracleConfig> {
  return {
    id: "oracle",
    shape: "listing-only",
    listingUrl,
    fetchListingRaw,
    parseListing: (raw) => parseListingFor(raw, config),
    selectLocal,
  };
}
