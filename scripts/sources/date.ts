// A timestamp with no zone is read as local time, which is the shift this
// pipeline already corrected once, so the zone is required rather than assumed.
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

// The spreadsheet reads an empty cell as an unknown date, so an input that
// cannot be trusted produces the same value a blank cell would.
const UNPARSEABLE = "";

function utcDate(isoTimestamp: string): Date | null {
  if (!ISO_TIMESTAMP.test(isoTimestamp)) {
    return null;
  }

  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDateOf(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function toIsoDate(isoTimestamp: string): string {
  const date = utcDate(isoTimestamp);
  return date === null ? UNPARSEABLE : isoDateOf(date);
}

export function toIsoDateFromEpochMs(epochMs: number): string {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? UNPARSEABLE : isoDateOf(date);
}

export function toSpreadsheetDate(isoTimestamp: string): string {
  const date = utcDate(isoTimestamp);
  if (date === null) {
    return UNPARSEABLE;
  }

  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}
