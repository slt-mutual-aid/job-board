import { describe, it, expect } from "vitest";
import { readers } from "./health-cli";
import { sources } from "./registry";

describe("source health coverage", () => {
  it("checks every source in the registry", () => {
    // A source the health run never reads is a source whose silence the summary
    // reports as nothing to see.
    expect(readers.map((reader) => reader.id).sort()).toEqual(
      sources.map((source) => source.sourceId).sort(),
    );
  });
});
