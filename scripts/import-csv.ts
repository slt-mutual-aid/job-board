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

// Load previously seen URLs from seen-urls.csv
function loadSeenUrls(): Set<string> {
  const urls = new Set<string>();
  if (!existsSync(seenUrlsPath)) {
    return urls;
  }
  const content = readFileSync(seenUrlsPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }
  return urls;
}

// Write all seen URLs to seen-urls.csv
function writeSeenUrls(urls: Set<string>): void {
  const sorted = [...urls].sort();
  writeFileSync(seenUrlsPath, sorted.join("\n") + "\n", "utf-8");
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

