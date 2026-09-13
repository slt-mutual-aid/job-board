// A timestamp with no zone is read as local time, which is the shift this
// pipeline already corrected once, so the zone is required rather than assumed.
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

// The spreadsheet reads an empty cell as an unknown date, so an input that
// cannot be trusted produces the same value a blank cell would.
const UNPARSEABLE = "";

export function toSpreadsheetDate(isoTimestamp: string): string {
  if (!ISO_TIMESTAMP.test(isoTimestamp)) {
    return UNPARSEABLE;
  }

  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return UNPARSEABLE;
  }

  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}
