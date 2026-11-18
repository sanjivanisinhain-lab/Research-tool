// Redaction runs BEFORE anything is stored or sent to an AI provider.
// Removes names, phone numbers, emails and cities. Counts are kept; removed values never are.

export type RedactionLists = { names: string[]; places: string[] };
export type RedactionCounts = { names: number; phones: number; emails: number; places: number };

const PHONE = /(?:\+?91[\s-]?)?(?<!\d)[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const LONG_DIGITS = /(?<!\d)\d{10,12}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildPattern(terms: string[]): RegExp | null {
  const uniq = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 3))].sort((a, b) => b.length - a.length);
  if (!uniq.length) return null;
  // Unicode-aware word boundaries (works with Latin and Devanagari).
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${uniq.map(esc).join("|")})(?![\\p{L}\\p{M}\\p{N}_])`, "giu");
}

/** Words that turn up in a Name or City cell without being a name ("Name not given", "New caller", "Unknown"). Removing them would damage the text, so they are never used as names. */
export const NOT_NAMES = new Set(["name", "names", "city", "phone", "email", "not", "given", "unknown", "none", "nil", "null", "new", "old", "caller", "customer", "user", "participant", "anonymous", "anon", "test", "pending", "tbd", "available", "and", "the", "for", "with", "sir", "madam", "mam", "mrs", "miss", "shri", "smt", "yes", "male", "female"]);
const onlyFiller = (words: string[]) => words.every((w) => NOT_NAMES.has(w.toLowerCase()));

/** Full names plus each name token of 3+ letters ("Sanjay Pandit" -> Sanjay, Pandit). Filler words are left out. */
export function nameTerms(fullNames: string[]): string[] {
  const out: string[] = [];
  for (const n of fullNames) {
    const clean = n.replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").trim();
    if (!clean) continue;
    const words = clean.split(/\s+/);
    const real = words.filter((w) => !NOT_NAMES.has(w.toLowerCase()));
    if (!real.length) continue;
    out.push(real.join(" "), ...real);
  }
  return out;
}

export function makeRedactor(lists: RedactionLists) {
  const nameRe = buildPattern(nameTerms(lists.names));
  const placeRe = buildPattern(lists.places.filter((p) => !onlyFiller(p.replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean))).flatMap((p) => [p, p.replace(/_/g, " ")]));
  return function redact(text: string): { text: string; counts: RedactionCounts } {
    const counts: RedactionCounts = { names: 0, phones: 0, emails: 0, places: 0 };
    let t = text;
    t = t.replace(EMAIL, () => (counts.emails++, "[EMAIL]"));
    t = t.replace(PHONE, () => (counts.phones++, "[PHONE]"));
    t = t.replace(LONG_DIGITS, () => (counts.phones++, "[PHONE]"));
    if (nameRe) t = t.replace(nameRe, () => (counts.names++, "[NAME]"));
    if (placeRe) t = t.replace(placeRe, () => (counts.places++, "[CITY]"));
    return { text: t, counts };
  };
}

export function addCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  return { names: a.names + b.names, phones: a.phones + b.phones, emails: a.emails + b.emails, places: a.places + b.places };
}
export const zeroCounts = (): RedactionCounts => ({ names: 0, phones: 0, emails: 0, places: 0 });
