import { fileURLToPath } from "url";
import { exitCodeFor, formatRunSummary } from "./health";
import { formatReviewSummary, readers, runReview } from "./review";

async function main(): Promise<void> {
  const { target, counts, assessments } = await runReview(readers, new Date());

  console.log(formatRunSummary(assessments));
  console.log(formatReviewSummary(counts));
  console.log(`Wrote ${target}`);

  process.exitCode = exitCodeFor(assessments);
}

// Importing this file from a test must not fetch every source.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
