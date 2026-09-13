// The shapes every job source adapter implements. A source that cannot be
// expressed here is a source whose output no shared consumer can read.

// Every adapter reports a response it cannot parse by throwing a subclass of
// this error, so a consumer can tell a changed endpoint from a programming
// fault without matching on message text.
export class SourceResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceResponseError";
  }
}

export interface PostingLiveness {
  // The source's own wording, kept verbatim so a value nobody has seen before
  // stays legible instead of collapsing into the boolean beside it.
  status: string;
  isOpen: boolean;
}

export interface SourcePosting {
  id: string;
  title: string;
  location: string;
  // Absolute, so a consumer never has to know which host it came from.
  applyLink: string;
  // ISO 8601 UTC calendar date, or "" when the source carries no usable date.
  // BambooHR publishes a date with no time of day, so an instant here would
  // invent a precision no source reports. The spreadsheet format is produced
  // at the point of printing by toSpreadsheetDate, which keeps the one field
  // sortable and comparable everywhere else.
  postedAt: string;
  commitment?: string;
  department?: string;
  description?: string;
  // Absent on a source that publishes no open or closed signal. Absence means
  // nothing checked the posting, which is not the same as an open posting, so
  // there is no default to read it through.
  liveness?: PostingLiveness;
}

export interface ListingResult<Entry> {
  entries: Entry[];
  // True only when the response was well formed and genuinely carried nothing.
  // A consumer can then tell a quiet day from a parse that lost every posting.
  confirmedEmpty: boolean;
}

interface AdapterBase<Config, Entry> {
  readonly id: string;
  listingUrl(config: Config): string;
  fetchListingRaw(config: Config): Promise<string>;
  parseListing(raw: string): ListingResult<Entry>;
  // Pure, so the location rule can be exercised without a request.
  selectLocal(entries: Entry[], config: Config): Entry[];
}

// A source whose one request already yields complete postings.
export interface ListingOnlyAdapter<Config> extends AdapterBase<
  Config,
  SourcePosting
> {
  readonly shape: "listing-only";
}

// A source whose listing carries identity and location but not the whole
// posting, so each selected entry costs a second request.
export interface ListingThenDetailAdapter<Config, Entry> extends AdapterBase<
  Config,
  Entry
> {
  readonly shape: "listing-then-detail";
  detailUrl(config: Config, entry: Entry): string;
  fetchDetailRaw(config: Config, entry: Entry): Promise<string>;
  parseDetail(raw: string, entry: Entry): SourcePosting;
}
