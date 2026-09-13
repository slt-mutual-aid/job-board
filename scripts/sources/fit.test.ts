import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { judgeFit, type FitVerdict } from "./fit";
import { toPagedListing } from "./adapters/ukg";
import {
  bambooHrSource,
  icimsDavidsonSource,
  icimsOvgSource,
  leverSource,
  oracleCaesarsSource,
  oracleRaleysSource,
  ukgSource,
} from "./registry";
import type { SourcePosting } from "./types";

function fixture(path: string): string {
  return readFileSync(new URL(`./__fixtures__/${path}`, import.meta.url), {
    encoding: "utf-8",
  });
}

function listingPostings<Config>(
  source: {
    adapter: {
      parseListing(raw: string): { entries: SourcePosting[] };
      selectLocal(entries: SourcePosting[], config: Config): SourcePosting[];
    };
    config: Config;
  },
  raw: string,
): SourcePosting[] {
  return source.adapter.selectLocal(
    source.adapter.parseListing(raw).entries,
    source.config,
  );
}

// BambooHR splits a posting across two requests, and one detail response is
// recorded, so the source contributes the one complete posting the repository
// holds rather than the three listing entries it cannot complete.
function bambooHrPosting(): SourcePosting {
  const { entries } = bambooHrSource.adapter.parseListing(
    fixture("bamboohr-vra/listing.json"),
  );
  const entry = entries.find((candidate) => candidate.id === "32");
  if (entry === undefined) {
    throw new Error("The recorded BambooHR listing has no entry 32");
  }
  return bambooHrSource.adapter.parseDetail(
    fixture("bamboohr-vra/detail-32.json"),
    entry,
  );
}

interface RecordedPosting {
  sourceId: string;
  posting: SourcePosting;
}

function recorded(): RecordedPosting[] {
  const bySource: Array<[string, SourcePosting[]]> = [
    [
      leverSource.sourceId,
      listingPostings(leverSource, fixture("lever-insomnia/listing.json")),
    ],
    [bambooHrSource.sourceId, [bambooHrPosting()]],
    [
      icimsOvgSource.sourceId,
      listingPostings(icimsOvgSource, fixture("icims-ovg/listing.html.txt")),
    ],
    [
      icimsDavidsonSource.sourceId,
      listingPostings(
        icimsDavidsonSource,
        fixture("icims-davidson/listing.html.txt"),
      ),
    ],
    [
      oracleCaesarsSource.sourceId,
      listingPostings(
        oracleCaesarsSource,
        fixture("oracle-caesars/listing.json"),
      ),
    ],
    [
      oracleRaleysSource.sourceId,
      listingPostings(
        oracleRaleysSource,
        fixture("oracle-raleys/listing.json"),
      ),
    ],
    [
      ukgSource.sourceId,
      listingPostings(
        ukgSource,
        toPagedListing(
          ukgSource.config,
          [0, 1, 2].map((index) => fixture(`ukg-ballys/page-${index}.json`)),
        ),
      ),
    ],
  ];

  return bySource.flatMap(([sourceId, postings]) =>
    postings.map((posting) => ({ sourceId, posting })),
  );
}

const RECORDED = recorded();

function posting(title: string): SourcePosting {
  const match = RECORDED.filter(
    (entry) => entry.posting.title.toLowerCase() === title.toLowerCase(),
  );
  if (match.length === 0) {
    throw new Error(`No recorded posting is titled ${title}`);
  }
  return match[0].posting;
}

function synthetic(fields: Partial<SourcePosting>): SourcePosting {
  return {
    id: "1",
    title: "Room Attendant",
    location: "South Lake Tahoe, CA",
    applyLink: "https://example.invalid/1",
    postedAt: "2026-01-05",
    ...fields,
  };
}

describe("judgeFit on the employment type", () => {
  it("calls a posting the source labels part time likely", () => {
    expect(judgeFit(posting("Cookie Crew"))).toEqual({
      verdict: "likely",
      reason: 'The employment type says "Part Time".',
    });
  });

  it("reads the hyphenated spelling one source publishes", () => {
    expect(
      judgeFit(posting("Banquet Server | Part-Time | Tahoe Blue Event Center")),
    ).toEqual({
      verdict: "likely",
      reason: 'The employment type says "Regular Part-Time".',
    });
  });

  it("reads a label naming both, because one of the two is part time", () => {
    expect(
      judgeFit(synthetic({ commitment: "Full Time or Part Time" })).verdict,
    ).toBe("likely");
  });

  it("reads the part time a UKG title carries and its employment type omits", () => {
    expect(judgeFit(posting("Spa Attendant (Part Time)"))).toEqual({
      verdict: "likely",
      reason: 'The title says "part time".',
    });
  });

  it("reads an on-call title the same way", () => {
    expect(
      judgeFit(posting("On Call Bartender - Cliche Cigar Bar")).verdict,
    ).toBe("likely");
  });

  it("calls the kitchen job the event center labels part time likely", () => {
    expect(
      judgeFit(posting("Cook | Part-Time | Tahoe Blue Event Center")),
    ).toEqual({
      verdict: "likely",
      reason: 'The employment type says "Regular Part-Time".',
    });
  });

  it("leaves a full time label undecided rather than ruling it out", () => {
    expect(judgeFit(posting("Barista (Full Time)")).verdict).toBe("unknown");
  });
});

describe("judgeFit on entry level work", () => {
  it("calls a posting saying it trains the applicant likely", () => {
    expect(
      judgeFit(
        synthetic({
          description:
            "No experience needed. Training provided on your first shift.",
        }),
      ),
    ).toEqual({
      verdict: "likely",
      reason: "The description says the job asks for no experience.",
    });
  });

  it("reads a stated hourly rate as hourly work", () => {
    expect(
      judgeFit(
        synthetic({
          description: "This role will pay an hourly rate of $20.00.",
        }),
      ).verdict,
    ).toBe("likely");
  });

  it("rules out a posting demanding years of experience", () => {
    expect(
      judgeFit(
        synthetic({
          description: "Requirements: 5 years of hotel experience.",
        }),
      ),
    ).toEqual({
      verdict: "unlikely",
      reason: "The description states an experience requirement.",
    });
  });

  it("reads a company history rather than a requirement out of a year count", () => {
    // Every Insomnia Cookies description opens with "fast forward 20 years".
    expect(judgeFit(posting("Cookie Delivery Driver")).verdict).toBe("likely");
  });

  it("rules out a posting naming a salary", () => {
    expect(
      judgeFit(
        synthetic({
          title: "Front Office Lead",
          description: "The annual salary for this position is $68,000.",
        }),
      ).verdict,
    ).toBe("unlikely");
  });
});

describe("judgeFit on roles the board does not carry", () => {
  it.each([
    [
      "Executive Casino Host",
      'The title says "executive", which names a senior role.',
    ],
    [
      "Executive Chef",
      'The title says "executive", which names a senior role.',
    ],
    [
      "Director of Food and Beverage",
      'The title says "director", which names a senior role.',
    ],
    ["Human Resources Manager", "The title names a manager role."],
  ])("rules out %s", (title, reason) => {
    expect(judgeFit(posting(title))).toEqual({ verdict: "unlikely", reason });
  });

  it("rules out a role asking for a license the applicant must already hold", () => {
    expect(
      judgeFit(posting("127 - Raley's Per Diem Pharmacist - South Lake Tahoe")),
    ).toEqual({
      verdict: "unlikely",
      reason:
        'The title says "pharmacist", so the job asks for a license or a certificate up front.',
    });
  });
});

describe("judgeFit on a posting carrying no signal", () => {
  it("leaves an Oracle posting with no employment type and no description unknown", () => {
    const kitchenSteward = posting("Kitchen Steward");

    expect(kitchenSteward.commitment).toBeUndefined();
    expect(kitchenSteward.description).toBeUndefined();
    expect(judgeFit(kitchenSteward)).toEqual({
      verdict: "unknown",
      reason:
        "The source publishes no employment type and no description, so nothing here decides it.",
    });
  });

  it("rules an Oracle posting out only on what its title says", () => {
    const oraclePostings = RECORDED.filter((entry) =>
      entry.sourceId.startsWith("oracle:"),
    ).map((entry) => entry.posting);
    const missingBoth = oraclePostings.filter(
      (candidate) =>
        candidate.commitment === undefined &&
        candidate.description === undefined,
    );

    // Oracle publishes neither field on any recorded requisition, so the only
    // evidence a verdict can rest on is the title the employer wrote.
    expect(missingBoth).toHaveLength(oraclePostings.length);
    const ruledOut = oraclePostings
      .map((candidate) => judgeFit(candidate))
      .filter((fit) => fit.verdict === "unlikely");
    expect(ruledOut).not.toEqual([]);
    expect(
      ruledOut.filter((fit) => !fit.reason.startsWith("The title")),
    ).toEqual([]);
  });

  it("leaves the dishwashing job a source describes without an hourly rate unknown", () => {
    // The card description says "washing dishes", and the source publishes no
    // employment type, so the posting is one for a reviewer to read.
    expect(judgeFit(posting("Steward | LandShark Bar & Grill")).verdict).toBe(
      "unknown",
    );
  });
});

describe("judgeFit on the roles a keyword rule gets wrong", () => {
  it("does not rule out an assistant manager on the word manager", () => {
    expect(
      judgeFit(posting("Assistant Restaurant Manager - OEM")).verdict,
    ).toBe("unknown");
  });

  it("does not rule out a shift manager either", () => {
    expect(judgeFit(posting("Hotel Guest Service Shift Manager")).verdict).toBe(
      "unknown",
    );
  });

  it("calls a shift leader the source labels part time likely", () => {
    // The description asks for a year of experience under a "Desired
    // skills/experience" heading, which is a preference rather than a bar.
    expect(judgeFit(posting("Shift Leader"))).toEqual({
      verdict: "likely",
      reason: 'The employment type says "Part Time".',
    });
  });

  it("does not rule out a junior role on the word host", () => {
    expect(judgeFit(posting("Junior Casino Host")).verdict).toBe("unknown");
  });
});

describe("judgeFit across every recorded posting", () => {
  function distribution(postings: SourcePosting[]): Record<FitVerdict, number> {
    const counts: Record<FitVerdict, number> = {
      likely: 0,
      unknown: 0,
      unlikely: 0,
    };
    for (const candidate of postings) {
      counts[judgeFit(candidate).verdict] += 1;
    }
    return counts;
  }

  it("sorts the recorded postings the way a reviewer reads them", () => {
    const perSource: Record<string, Record<FitVerdict, number>> = {};
    for (const { sourceId } of RECORDED) {
      perSource[sourceId] = distribution(
        RECORDED.filter((entry) => entry.sourceId === sourceId).map(
          (entry) => entry.posting,
        ),
      );
    }

    expect(perSource).toEqual({
      lever: { likely: 3, unknown: 0, unlikely: 0 },
      bamboohr: { likely: 0, unknown: 0, unlikely: 1 },
      "icims:ovg": { likely: 6, unknown: 0, unlikely: 0 },
      "icims:davidson": { likely: 1, unknown: 10, unlikely: 3 },
      "oracle:caesars": { likely: 2, unknown: 62, unlikely: 8 },
      "oracle:raleys": { likely: 0, unknown: 4, unlikely: 2 },
      "ukg:ballys": { likely: 11, unknown: 18, unlikely: 4 },
    });
    expect(distribution(RECORDED.map((entry) => entry.posting))).toEqual({
      likely: 23,
      unknown: 94,
      unlikely: 18,
    });
  });

  it("gives every recorded posting a reason a reviewer can disagree with", () => {
    const empty = RECORDED.filter(
      (entry) => judgeFit(entry.posting).reason.trim() === "",
    );

    expect(empty).toEqual([]);
  });
});
