import { readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const FIXTURES_ROOT = fileURLToPath(new URL("./__fixtures__", import.meta.url));

// A recorded page carries the employer's own third-party scripts, and CodeQL
// reads a committed .html file as this project's own source, which reports
// those scripts as findings here. A recorded page therefore ends in .html.txt.
// Every parser in this directory reads a fixture as bytes, so the name is free.
const SCANNED_SUFFIXES = [".html", ".htm"];

function fixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? fixtureFiles(path) : [path];
  });
}

describe("recorded fixtures", () => {
  it("gives every recorded page a name no code scanner reads as source", () => {
    const scanned = fixtureFiles(FIXTURES_ROOT).filter((path) =>
      SCANNED_SUFFIXES.some((suffix) => path.endsWith(suffix)),
    );

    expect(scanned).toEqual([]);
  });
});
