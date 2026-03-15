import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Job } from "../src/lib/db";

const jsonPath = join(process.cwd(), "jobboard.json");
const csvPath = join(process.cwd(), "slt-jobs.csv");
const seenUrlsPath = join(process.cwd(), "seen-urls.csv");

// Sentinel date for unknown posted dates (epoch: 1970-01-01T00:00:00.000Z)
const UNKNOWN_DATE = new Date(0).toISOString();

// Parse date from MM/DD/YYYY format to ISO string
function parseDate(dateStr: string | undefined): string {
  if (!dateStr || dateStr.trim() === "") {
    return UNKNOWN_DATE;
  }

  // Check for "Unknown" (case-insensitive)
  if (dateStr.trim().toLowerCase() === "unknown") {
    return UNKNOWN_DATE;
  }

  const parts = dateStr.trim().split("/");
  if (parts.length === 3) {
    const month = parseInt(parts[0], 10) - 1; // Month is 0-indexed
    const day = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    const date = new Date(year, month, day);
    return date.toISOString();
  }

  return new Date().toISOString();
}

// Check if a string is a valid URL.
function isValidUrl(urlStr: string): boolean {
  if (!urlStr || urlStr.trim() === "") {
    return false;
  }
  try {
    const url = new URL(urlStr.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Guess the base "all jobs" listing URL from a specific job URL.
// Looks for path anchors like "jobs", "job", "careers", "JobBoard" and truncates
// after them. Falls back to stripping trailing ID-like path segments.
function guessBaseUrl(jobUrl: string): string {
  const url = new URL(jobUrl);

  // Query params that are job-specific or just tracking noise
  const stripParams = new Set([
    "jobId", "opportunityId", "applyId", "source", "utm_source",
    "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "_gl", "indeed-apply-token", "iis", "iisn", "codes", "c",
    "mobile", "width", "height", "bga", "needsRedirect",
    "jan1offset", "jun1offset", "callback_url",
  ]);
  for (const key of [...url.searchParams.keys()]) {
    if (stripParams.has(key)) {
      url.searchParams.delete(key);
    }
  }

  const segments = url.pathname.split("/").filter(Boolean);

  // Anchors that typically represent a job listing directory
  const anchors = ["jobs", "job", "careers", "job-listings", "jobboard"];

  const isIdLike = (s: string) =>
    /^\d+$/.test(s) ||                    // pure numeric ID
    /^[0-9a-f]{8}-/.test(s) ||            // UUID prefix
    /^[A-Z0-9_-]{20,}$/.test(s) ||        // long alphanumeric token
    /^[A-Z]\d{4,}/.test(s) ||             // code like R0058627
    s.endsWith(".html") ||
    (s.split("-").length >= 4 && s.length > 20);  // long hyphenated slug (job title)

  // Find the first anchor segment, then walk forward keeping non-ID segments
  // (which may include additional anchors like /careers/slaketahoe/jobs)
  let anchorIndex = segments.findIndex(s => anchors.includes(s.toLowerCase()));

  if (anchorIndex >= 0) {
    let endIndex = anchorIndex + 1;
    // Continue past the anchor, keeping non-ID segments (stop at first ID-like one)
    while (endIndex < segments.length && !isIdLike(segments[endIndex])) {
      endIndex++;
    }
    url.pathname = "/" + segments.slice(0, endIndex).join("/");
    url.search = "";
    return url.toString();
  }

  // Platform-specific fallbacks
  const host = url.hostname;

  // ADP: strip jobId param
  if (host.includes("adp.com")) {
    url.searchParams.delete("jobId");
    return url.toString();
  }

  // UltiPro: keep up to JobBoard UUID
  if (host.includes("ultipro.com")) {
    const jbIdx = segments.findIndex(s => s.toLowerCase() === "jobboard");
    if (jbIdx >= 0 && jbIdx + 1 < segments.length) {
      url.pathname = "/" + segments.slice(0, jbIdx + 2).join("/");
      url.search = "";
      return url.toString();
    }
  }

  // Google/Office forms: the form URL itself is the base
  if (host.includes("docs.google.com") || host.includes("forms.office.com")) {
    url.search = "";
    return url.toString();
  }

  // Fallback: strip trailing segments that look like IDs (numeric, UUIDs, long hashes)
  let cutoff = segments.length;
  while (cutoff > 1 && isIdLike(segments[cutoff - 1])) {
    cutoff--;
  }
  if (cutoff < segments.length) {
    url.pathname = "/" + segments.slice(0, cutoff).join("/");
    url.search = "";
    return url.toString();
  }

  // Last resort: return origin + first path segment
  url.search = "";
  return url.toString();
}

// Load previously seen URLs from seen-urls.csv (col1=job_url, col2=base_url)
function loadSeenUrls(): Set<string> {
  const urls = new Set<string>();
  if (!existsSync(seenUrlsPath)) {
    return urls;
  }
  const content = readFileSync(seenUrlsPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("job_url,")) continue;
    // First column is the job URL
    const commaIdx = trimmed.indexOf(",");
    const jobUrl = commaIdx >= 0 ? trimmed.slice(0, commaIdx) : trimmed;
    if (jobUrl) urls.add(jobUrl);
  }
  return urls;
}

// Write all seen URLs to seen-urls.csv with base URL column
function writeSeenUrls(urls: Set<string>): void {
  const sorted = [...urls].sort();
  const lines = ["job_url,base_url"];
  for (const jobUrl of sorted) {
    const baseUrl = guessBaseUrl(jobUrl);
    lines.push(`${jobUrl},${baseUrl}`);
  }
  writeFileSync(seenUrlsPath, lines.join("\n") + "\n", "utf-8");
  console.log(`Wrote ${sorted.length} unique URLs to seen-urls.csv`);
}

function importCsvToJson() {
  console.log("Reading CSV file...");
  const csvContent = readFileSync(csvPath, "utf-8");
  const seenUrls = loadSeenUrls();
  console.log(`Loaded ${seenUrls.size} previously seen URLs`);

  console.log("Parsing CSV...");
  const records = parse(csvContent, {
    columns: [
      "Date Posted",
      "Company",
      "Job Title",
      "Application Link",
      "Type of work",
      "Hourly Rate",
      "Location",
      "Description",
      "Job Closes by",
    ],
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  }) as Array<{
    "Date Posted": string;
    Company: string;
    "Job Title": string;
    "Application Link": string;
    "Type of work": string;
    "Hourly Rate": string;
    Location: string;
    Description: string;
  }>;

  console.log(`Found ${records.length} job records`);

  // Map CSV records to Job format and filter out invalid/duplicate records
  let invalidCount = 0;
  let duplicateCount = 0;
  const jobsWithoutIds = records
    .map((record, index): Omit<Job, "id"> | null => {
      const title = record["Job Title"]?.trim() || "";
      const company = record.Company?.trim() || "";
      const location = record.Location?.trim() || "Unknown";
      const description = record.Description?.trim() || "No Description";
      const applicationLinkValue = record["Application Link"]?.trim() || "";

      // Skip records missing required fields (title and company are required)
      if (!title || !company) {
        invalidCount++;
        const missingFields: string[] = [];
        if (!title) missingFields.push("Job Title");
        if (!company) missingFields.push("Company");

        console.error(
          `Invalid record at row ${index + 2} (CSV row ${index + 2}): Missing required fields: ${missingFields.join(", ")}`
        );
        return null;
      }

      // Determine if the application link is a valid URL or should be treated as instructions.
      const isUrl = isValidUrl(applicationLinkValue);
      const apply_link = isUrl ? applicationLinkValue : undefined;
      const application_instructions = isUrl ? undefined : applicationLinkValue || undefined;

      // Skip jobs with URLs we've already seen
      if (apply_link && seenUrls.has(apply_link)) {
        duplicateCount++;
        console.log(`Skipping duplicate URL at row ${index + 2}: ${apply_link}`);
        return null;
      }

      // Track new URLs
      if (apply_link) {
        seenUrls.add(apply_link);
      }

      return {
        title,
        company,
        location,
        description,
        apply_link,
        application_instructions,
        hourly_rate: record["Hourly Rate"]?.trim() || undefined,
        job_type: record["Type of work"]?.trim() || undefined,
        posted_date: parseDate(record["Date Posted"]),
      };
    })
    .filter((job): job is Omit<Job, "id"> => job !== null);

  // Assign sequential IDs starting from 1
  const jobs: Job[] = jobsWithoutIds.map((job, index) => ({
    ...job,
    id: index + 1,
  }));

  if (invalidCount > 0) {
    console.log(`Skipped ${invalidCount} invalid record(s)`);
  }
  if (duplicateCount > 0) {
    console.log(`Skipped ${duplicateCount} duplicate URL(s)`);
  }

  console.log("Writing jobs to JSON file...");
  writeFileSync(jsonPath, JSON.stringify(jobs, null, 2), "utf-8");

  // Write updated seen URLs
  writeSeenUrls(seenUrls);

  console.log(`Successfully imported ${jobs.length} jobs`);
}

importCsvToJson();

