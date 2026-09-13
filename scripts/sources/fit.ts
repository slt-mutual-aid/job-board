import type { SourcePosting } from "./types";

// A posting reaches "unlikely" only on evidence that it is something the board
// does not carry. A field the source leaves out is not evidence, so a posting
// nothing could be read from stays "unknown".
export type FitVerdict = "likely" | "unknown" | "unlikely";

export interface PostingFit {
  verdict: FitVerdict;
  // Plain language, naming the evidence, for a volunteer reading a queue.
  reason: string;
}

// Punctuation separates words on a job board as often as a space does:
// "Part-Time", "(Part Time)" and "Full Time or Part Time" are one employment
// type written three ways. Every phrase below is matched against this form,
// padded so a match lands on whole words.
function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

function holds(padded: string, phrase: string): boolean {
  return padded.includes(` ${phrase} `);
}

function holdsAny(padded: string, phrases: readonly string[]): string | null {
  return phrases.find((phrase) => holds(padded, phrase)) ?? null;
}

// Titles an employer writes for a salaried role running a department. The
// board carries the hourly work under such a role, not the role itself.
const SENIOR_TITLE_WORDS = [
  "executive",
  "director",
  "chief",
  "president",
  "vice president",
  "principal",
  "senior",
  "sr",
] as const;

// A role named Manager is the employer stating the job runs a department.
const MANAGER = "manager";

// "Assistant Restaurant Manager" and "Shift Manager" are the hourly floor jobs
// a casino and a hotel both title with the word, and they are exactly the rows
// this board already carries, so the word alone rules nothing out.
const MANAGER_EXEMPTIONS = ["assistant", "shift manager"] as const;

// Titles naming a state license or a certification the applicant must already
// hold. The board serves people who can start next week, and a license takes
// months. The list stays at titles: a description mentioning a driver's license
// would otherwise rule out every delivery job.
const CREDENTIAL_TITLE_WORDS = [
  "pharmacist",
  "nurse",
  "rn",
  "therapist",
  "emt",
  "paramedic",
  "cdl",
  "certified",
  "licensed",
] as const;

const SALARIED_PHRASES = [
  "annual salary",
  "salary range",
  "salaried position",
  "exempt position",
] as const;

// An employment type is written a different way by every source, so the test is
// whether the value carries the phrase rather than whether it equals it.
const PART_TIME_COMMITMENTS = [
  "part time",
  "on call",
  "per diem",
  "hourly",
] as const;

// UKG publishes a boolean that is false for part-time and on-call alike, so its
// adapter writes no employment type at all and the posting says "(Part Time)"
// in the title instead. Reading the title recovers the statement the employer
// did publish.
const PART_TIME_TITLE_PHRASES = ["part time", "on call"] as const;

// "hr" is left out on purpose: normalizing "$20/hr" and "HR Generalist" both
// produce the same token, and a human resources posting is not hourly work.
const HOURLY_PAY_PHRASES = ["hourly rate", "per hour", "an hour"] as const;

const ENTRY_LEVEL_PHRASES = [
  "no experience",
  "no prior experience",
  "no previous experience",
  "entry level",
  "will train",
  "training provided",
  "training is provided",
  "on the job training",
] as const;

// A stated requirement, not a company history. Insomnia Cookies opens every
// description with "fast forward 20 years", so a bare year count is no evidence
// at all and the match has to reach the word experience.
const EXPERIENCE_REQUIRED =
  /\b\d+\+?\s*(?:or more\s*)?(?:-|to)?\s*\d*\s*years?[’'s]*\s+(?:of\s+)?(?:[a-z]+\s+){0,3}experience|minimum of \w+ years?|experience (?:is )?required|must have (?:at least |a minimum of )?\d+\s*years?/;

// The same listing prints "Desired skills/experience: at least 1 year" under a
// heading that makes the year count a preference. A preference is not a
// requirement, so the heading in front of a match cancels it.
const PREFERENCE_HEADINGS = [
  "desired",
  "preferred",
  "nice to have",
  "a plus",
  "bonus",
] as const;
const PREFERENCE_WINDOW = 120;

function experienceIsRequired(description: string): boolean {
  const match = EXPERIENCE_REQUIRED.exec(description.toLowerCase());
  if (match === null) {
    return false;
  }
  const before = words(
    description.slice(
      Math.max(0, match.index - PREFERENCE_WINDOW),
      match.index,
    ),
  );
  return holdsAny(before, PREFERENCE_HEADINGS) === null;
}

function quote(text: string): string {
  return `"${text}"`;
}

export function judgeFit(posting: SourcePosting): PostingFit {
  const title = words(posting.title);
  const commitment = posting.commitment ?? "";
  const description = posting.description ?? "";
  const descriptionWords = words(description);

  const senior = holdsAny(title, SENIOR_TITLE_WORDS);
  if (senior !== null) {
    return {
      verdict: "unlikely",
      reason: `The title says ${quote(senior)}, which names a senior role.`,
    };
  }

  if (holds(title, MANAGER) && holdsAny(title, MANAGER_EXEMPTIONS) === null) {
    return {
      verdict: "unlikely",
      reason: "The title names a manager role.",
    };
  }

  const credential = holdsAny(title, CREDENTIAL_TITLE_WORDS);
  if (credential !== null) {
    return {
      verdict: "unlikely",
      reason: `The title says ${quote(credential)}, so the job asks for a license or a certificate up front.`,
    };
  }

  const salaried = holdsAny(descriptionWords, SALARIED_PHRASES);
  if (salaried !== null) {
    return {
      verdict: "unlikely",
      reason: `The description says ${quote(salaried)}, which names salaried work rather than hourly work.`,
    };
  }

  if (experienceIsRequired(description)) {
    return {
      verdict: "unlikely",
      reason: "The description states an experience requirement.",
    };
  }

  const partTime = holdsAny(words(commitment), PART_TIME_COMMITMENTS);
  if (partTime !== null) {
    return {
      verdict: "likely",
      reason: `The employment type says ${quote(commitment)}.`,
    };
  }

  const partTimeTitle = holdsAny(title, PART_TIME_TITLE_PHRASES);
  if (partTimeTitle !== null) {
    return {
      verdict: "likely",
      reason: `The title says ${quote(partTimeTitle)}.`,
    };
  }

  if (holdsAny(descriptionWords, ENTRY_LEVEL_PHRASES) !== null) {
    return {
      verdict: "likely",
      reason: "The description says the job asks for no experience.",
    };
  }

  if (holdsAny(descriptionWords, HOURLY_PAY_PHRASES) !== null) {
    return {
      verdict: "likely",
      reason: "The description states an hourly pay rate.",
    };
  }

  // Absence is the common case, not the rare one: two of the seven sources
  // publish no employment type and no description at all. A posting nothing
  // read is a posting for a reviewer to read, so it stays in the queue.
  if (commitment === "" && description === "") {
    return {
      verdict: "unknown",
      reason:
        "The source publishes no employment type and no description, so nothing here decides it.",
    };
  }

  return {
    verdict: "unknown",
    reason:
      "Nothing in the employment type, the title, or the description says the job is hourly or asks for experience.",
  };
}
