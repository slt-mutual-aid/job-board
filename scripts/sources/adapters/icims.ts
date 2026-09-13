// Re-record the fixtures in scripts/sources/__fixtures__/icims-ovg and
// scripts/sources/__fixtures__/icims-davidson with:
//
//   curl -sS -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://careers-ovg.icims.com/jobs/search?ss=1&searchZip=96150&searchRadius=20&in_iframe=1' \
//     -o scripts/sources/__fixtures__/icims-ovg/listing.html
//
//   curl -sS -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://careers-ovg.icims.com/jobs/search?ss=1&searchZip=99801&searchRadius=5&in_iframe=1' \
//     -o scripts/sources/__fixtures__/icims-ovg/empty.html
//
//   curl -sS -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://careers-davidsonhospitality.icims.com/jobs/search?ss=1&searchZip=96150&searchRadius=20&in_iframe=1' \
//     -o scripts/sources/__fixtures__/icims-davidson/listing.html
//
//   curl -sS -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
//     'https://careers-davidsonhospitality.icims.com/jobs/search?ss=1&searchZip=99801&searchRadius=5&in_iframe=1' \
//     -o scripts/sources/__fixtures__/icims-davidson/empty.html
//
// Update the fetchedAt timestamp in each accompanying .meta.json afterwards.

import { fetchText } from "../http";
import { htmlToPlainText } from "../text";
import { toIsoDate } from "../date";
import {
  SourceResponseError,
  type ListingOnlyAdapter,
  type ListingResult,
  type SourcePosting,
} from "../types";

export interface IcimsConfig {
  // The host the listing is read from.
  host: string;
  // The center of the radius the iCIMS server searches.
  searchZip: string;
  searchRadiusMiles: number;
  // Every host a board link may carry for the account, the one read from
  // included. iCIMS publishes an account under more than one hostname and the
  // spreadsheet was filled in from whichever one the employer advertised.
  linkHosts: readonly string[];
  // Matched against the card's Location field as exact strings, which
  // re-asserts locally the radius the server already applied.
  locations: readonly string[];
}

export class IcimsResponseError extends SourceResponseError {
  constructor(message: string) {
    super(message);
    this.name = "IcimsResponseError";
  }
}

// A plain /jobs/search request answers with a consent wrapper carrying no
// postings. in_iframe=1 is what asks for the listing itself.
export function listingUrl(config: IcimsConfig): string {
  const query = new URLSearchParams({
    ss: "1",
    searchZip: config.searchZip,
    searchRadius: String(config.searchRadiusMiles),
    in_iframe: "1",
  });
  return `https://${config.host}/jobs/search?${query.toString()}`;
}

export async function fetchListingRaw(config: IcimsConfig): Promise<string> {
  return fetchText(listingUrl(config));
}

// Present on the listings page whether or not it carries postings, and absent
// from the consent wrapper, so it separates a page with nothing on it from a
// page this adapter cannot read at all.
const LISTINGS_PAGE = 'class="iCIMS_MainWrapper iCIMS_ListingsPage';

const NO_RESULTS = "Sorry, no jobs were found that match your search criteria.";

const JOBS_TABLE_OPEN = '<ul class="container-fluid iCIMS_JobsTable">';

const CARD = /<li class="iCIMS_JobCardItem">([\s\S]*?)<\/li>/g;

const TITLE_BLOCK = /<div class="col-xs-12 title">([\s\S]*?)<\/div>/;
const TITLE_LINK = /<a href="([^"]+)"/;
const TITLE_TEXT = /<h3[^>]*>([\s\S]*?)<\/h3>/;

const DESCRIPTION_BLOCK =
  /<div class="col-xs-12 description">([\s\S]*?)<\/div>/;

const HEADER_FIELD =
  /<dt class="iCIMS_JobHeaderField">([\s\S]*?)<\/dt>\s*<dd class="iCIMS_JobHeaderData">([\s\S]*?)<\/dd>/g;

// One account labels a card with a posted date and another publishes none at
// all, so the label is what decides whether a date is owed.
const POSTED_DATE_LABEL = /field-label">[^<]*Posted Date<\/span>/;

// The listing renders the date in the account's own zone and prints no zone
// with it, so only the calendar date it shows survives the read.
const POSTED_DATE =
  /field-label">[^<]*Posted Date<\/span>\s*<span title="(\d{1,2})\/(\d{1,2})\/(\d{4})[^"]*"/;

// "Search Results Page 1 of 3" is the source counting its own pages, and one
// request reads one of them.
const PAGE_COUNT =
  /iCIMS_SearchResultsHeader[\s\S]{0,2000}?Page\s+(\d+)\s+of\s+(\d+)/;

// A posting page is /jobs/<id>/<slug>/job. The number is the identity the
// board link carries and the slug follows whatever the employer retitles to.
const POSTING_PATH = /^\/jobs\/(\d+)\/[^/]+\/job$/;

// One account writes "Location : Location" and another writes "Location", and
// the same card also carries "Location Name" holding a venue rather than a
// place, which is why the accepted labels are listed rather than matched on.
const LOCATION_LABELS = ["Location", "Location : Location"];
const COMMITMENT_LABELS = ["Type", "Position Type"];
const DEPARTMENT_LABEL = "Category";

function labelledFields(card: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [, label, value] of card.matchAll(HEADER_FIELD)) {
    fields.set(htmlToPlainText(label), htmlToPlainText(value));
  }
  return fields;
}

function firstOf(
  fields: Map<string, string>,
  labels: readonly string[],
): string | undefined {
  for (const label of labels) {
    const value = fields.get(label);
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

interface PostingLink {
  id: string;
  applyLink: string;
}

// The href carries in_iframe=1 so that the embedded page links onward to
// itself. A job seeker opening the board wants the page, not the frame.
function toPostingLink(href: string, where: string): PostingLink {
  let link: URL;
  try {
    link = new URL(htmlToPlainText(href));
  } catch {
    throw new IcimsResponseError(
      `${where} has no absolute link, found "${href}"`,
    );
  }

  const path = POSTING_PATH.exec(link.pathname);
  if (link.protocol !== "https:" || path === null) {
    throw new IcimsResponseError(
      `${where} links to ${link.href}, which is not an iCIMS posting page`,
    );
  }

  return { id: path[1], applyLink: `${link.origin}${link.pathname}` };
}

function postedAtOf(card: string, where: string): string {
  if (!POSTED_DATE_LABEL.test(card)) {
    return "";
  }

  const parts = POSTED_DATE.exec(card);
  if (parts === null) {
    throw new IcimsResponseError(
      `${where} labels a posted date it does not write as a M/D/YYYY title`,
    );
  }

  const [, month, day, year] = parts;
  return toIsoDate(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
}

function toPosting(card: string, index: number): SourcePosting {
  const where = `Job card at index ${index}`;

  const title = TITLE_BLOCK.exec(card);
  if (title === null) {
    throw new IcimsResponseError(`${where} has no title block`);
  }

  const href = TITLE_LINK.exec(title[1]);
  const heading = TITLE_TEXT.exec(title[1]);
  if (href === null || heading === null) {
    throw new IcimsResponseError(`${where} has no titled posting link`);
  }

  const { id, applyLink } = toPostingLink(href[1], where);
  const titleText = htmlToPlainText(heading[1]);
  if (titleText === "") {
    throw new IcimsResponseError(`${where} has an empty title`);
  }

  const fields = labelledFields(card);
  const location = firstOf(fields, LOCATION_LABELS);
  if (location === undefined) {
    throw new IcimsResponseError(
      `${where} carries none of the location fields ${LOCATION_LABELS.join(", ")}`,
    );
  }

  const description = DESCRIPTION_BLOCK.exec(card);
  if (description === null) {
    throw new IcimsResponseError(`${where} has no description block`);
  }
  const descriptionText = htmlToPlainText(description[1]);

  // liveness stays absent. Every posting here came out of today's listing, so
  // a per-posting check could only repeat what the listing already said, and
  // the 410 an expired posting answers with reaches this project as a board
  // row reconcile.ts finds missing from two healthy listings in a row.
  return {
    id,
    title: titleText,
    location,
    applyLink,
    postedAt: postedAtOf(card, where),
    commitment: firstOf(fields, COMMITMENT_LABELS),
    department: fields.get(DEPARTMENT_LABEL) || undefined,
    description: descriptionText === "" ? undefined : descriptionText,
  };
}

function jobsTable(raw: string): string {
  const start = raw.indexOf(JOBS_TABLE_OPEN);
  if (start === -1) {
    throw new IcimsResponseError(
      "Response carries neither a job table nor the no-results message",
    );
  }

  const from = start + JOBS_TABLE_OPEN.length;
  const end = raw.indexOf("</ul>", from);
  if (end === -1) {
    throw new IcimsResponseError("Response ends inside the job table");
  }
  return raw.slice(from, end);
}

function assertSinglePage(raw: string): void {
  const pages = PAGE_COUNT.exec(raw);
  if (pages === null) {
    throw new IcimsResponseError(
      "Response carries a job table but no page count",
    );
  }

  const total = Number(pages[2]);
  if (total !== 1) {
    throw new IcimsResponseError(
      `Response is page ${pages[1]} of ${total} and this adapter reads one page, so ${total - 1} page(s) of postings would go unread`,
    );
  }
}

export function parseListing(raw: string): ListingResult<SourcePosting> {
  if (!raw.includes(LISTINGS_PAGE)) {
    throw new IcimsResponseError(
      "Response is not an iCIMS job listings page; a request without in_iframe=1 answers with the consent wrapper instead",
    );
  }

  if (!raw.includes(JOBS_TABLE_OPEN) && raw.includes(NO_RESULTS)) {
    return { entries: [], confirmedEmpty: true };
  }

  const table = jobsTable(raw);
  assertSinglePage(raw);

  const entries = [...table.matchAll(CARD)].map((card, index) =>
    toPosting(card[1], index),
  );
  if (entries.length === 0) {
    throw new IcimsResponseError("Job table carries no job cards");
  }

  return { entries, confirmedEmpty: false };
}

export function selectLocal(
  entries: SourcePosting[],
  config: IcimsConfig,
): SourcePosting[] {
  return entries.filter((entry) => config.locations.includes(entry.location));
}

// The numeric id of a posting page on one of the account's hosts, or null for
// a link this account does not answer for.
export function boardLinkPostingId(
  config: IcimsConfig,
  link: URL,
): string | null {
  if (!config.linkHosts.includes(link.hostname)) {
    return null;
  }
  const path = POSTING_PATH.exec(link.pathname);
  return path === null ? null : path[1];
}

export const icimsAdapter: ListingOnlyAdapter<IcimsConfig> = {
  id: "icims",
  shape: "listing-only",
  listingUrl,
  fetchListingRaw,
  parseListing,
  selectLocal,
};
