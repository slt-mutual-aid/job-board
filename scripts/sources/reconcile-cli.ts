import { fileURLToPath } from "url";
import { exitCodeFor, formatRunSummary, recordRun } from "./health";
import { readers } from "./health-cli";
import {
  readBoardRows,
  reconcileToDisk,
  type ReconcileResult,
} from "./reconcile";
import type { SourceObservation } from "./health";
import type { IdentifiedEntry } from "./types";

// An expired posting page answers with the same 200 as a live one on most of
// the platforms the board links to, so the only evidence this command acts on
// is whether a freshly fetched listing still carries the posting.
export async function runReconciliation(
  now: Date,
  root?: string,
): Promise<{ result: ReconcileResult; target: string; exitCode: number }> {
  const observations: SourceObservation<IdentifiedEntry>[] = [];
  for (const reader of readers) {
    console.log(`Checking ${reader.id}...`);
    observations.push(await reader.read());
  }

  const assessments = recordRun(observations, { now, root });
  console.log(formatRunSummary(assessments));

  const { result, target } = reconcileToDisk(
    readBoardRows(root),
    assessments,
    now,
    root,
  );

  return { result, target, exitCode: exitCodeFor(assessments) };
}

function printSummary(result: ReconcileResult, target: string): void {
  console.log(
    `${result.coveredRows} of ${result.coveredRows + result.uncoveredRows} board rows carry a link an adapter reads; the other ${result.uncoveredRows} are not reconciled.`,
  );
  for (const source of result.unreconciled) {
    console.log(
      `${source.sourceId} is ${source.status}, so its ${source.coveredRows} board row(s) produced no conclusions.`,
    );
  }
  console.log(
    `${result.recommended.length} row(s) recommended for removal, ${result.watching.length} watched.`,
  );
  console.log(`Wrote ${target}`);
  console.log(
    "Nothing was removed. A person confirms each posting and removes the row from the spreadsheet.",
  );
}

async function main(): Promise<void> {
  const { result, target, exitCode } = await runReconciliation(new Date());
  printSummary(result, target);
  process.exitCode = exitCode;
}

// Importing this file from a test must not fetch every source.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
