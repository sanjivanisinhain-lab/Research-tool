// Who a participant is: age, tier, state, gender, how they pay, new or repeat. Used to build audiences by filter.
// Values come from the sheet's own columns first, then from details the researchers wrote in the notes, and last from the city
// (which is turned into a state and a tier here, then discarded: the city itself is never stored).
import crypto from "node:crypto";
import type { Db } from "./db";

export type Tier = "Tier 1" | "Tier 2" | "Tier 3";
export type Attrs = { age: number | null; tier: Tier | null; state: string | null; gender: "male" | "female" | "other" | null; payment: "cod" | "prepaid" | "both" | null; customer: "new" | "repeat" | null };
export type AttrSource = "sheet" | "notes" | "city";
export const ATTR_KEYS = ["age", "tier", "state", "gender", "payment", "customer"] as const;
export type AttrKey = (typeof ATTR_KEYS)[number];
const RANK: Record<AttrSource, number> = { city: 1, notes: 2, sheet: 3 }; // a person's own sheet beats what a researcher wrote, which beats a guess from the city

export const emptyAttrs = (): Attrs => ({ age: null, tier: null, state: null, gender: null, payment: null, customer: null });

// ---------- normalising what people type ----------
const STATES: Record<string, string[]> = {
  "Andhra Pradesh": ["ap", "andhra"], "Arunachal Pradesh": ["ar"], "Assam": ["as"], "Bihar": ["br", "bh"], "Chhattisgarh": ["cg", "ct", "chattisgarh"], "Goa": ["ga"], "Gujarat": ["gj"], "Haryana": ["hr"],
  "Himachal Pradesh": ["hp"], "Jharkhand": ["jh"], "Karnataka": ["ka"], "Kerala": ["kl"], "Madhya Pradesh": ["mp"], "Maharashtra": ["mh"], "Manipur": ["mn"], "Meghalaya": ["ml"], "Mizoram": ["mz"], "Nagaland": ["nl"],
  "Odisha": ["od", "or", "orissa"], "Punjab": ["pb"], "Rajasthan": ["rj"], "Sikkim": ["sk"], "Tamil Nadu": ["tn", "tamilnadu"], "Telangana": ["tg", "ts"], "Tripura": ["tr"], "Uttar Pradesh": ["up"], "Uttarakhand": ["uk", "ut", "uttaranchal"],
  "West Bengal": ["wb", "bengal"], "Delhi": ["dl", "nct", "new delhi", "delhi ncr"], "Jammu and Kashmir": ["jk", "j&k", "jammu & kashmir", "jammu kashmir"], "Ladakh": ["la"], "Chandigarh": ["ch"], "Puducherry": ["py", "pondicherry"],
  "Andaman and Nicobar Islands": ["an"], "Dadra and Nagar Haveli and Daman and Diu": ["dd", "dn"], "Lakshadweep": ["ld"],
};
const STATE_BY_ALIAS = new Map<string, string>();
for (const [name, aliases] of Object.entries(STATES)) { STATE_BY_ALIAS.set(name.toLowerCase(), name); for (const a of aliases) STATE_BY_ALIAS.set(a, name); }
export const STATE_NAMES = Object.keys(STATES).sort();

export function normaliseState(s: unknown): string | null { return STATE_BY_ALIAS.get(String(s ?? "").toLowerCase().replace(/[^\p{L}\s&]/gu, " ").replace(/\s+/g, " ").trim()) ?? null; }
export function normaliseTier(s: unknown): Tier | null {
  const m = /^\s*(?:tier|t|city tier)?\s*[-:]?\s*([123])\s*(?:city|cities)?\s*$/i.exec(String(s ?? ""));
  if (m) return `Tier ${m[1]}` as Tier;
  return /^\s*metro\s*$/i.test(String(s ?? "")) ? "Tier 1" : null;
}
export function normaliseAge(s: unknown): number | null {
  const m = /^\s*(\d{1,2})\s*(?:yrs?|years?|y\.?o\.?)?\s*$/i.exec(String(s ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return n >= 10 && n <= 90 ? n : null; // a band such as "25-34" is not an age: leave it unknown rather than guess
}
export function normaliseGender(s: unknown): Attrs["gender"] {
  const t = String(s ?? "").trim().toLowerCase();
  if (/^(m|male|man|boy|purush)$/.test(t)) return "male";
  if (/^(f|female|woman|girl|mahila)$/.test(t)) return "female";
  return /^(other|non[- ]?binary|third gender)$/.test(t) ? "other" : null;
}
export function normalisePayment(s: unknown): Attrs["payment"] {
  const t = String(s ?? "").trim().toLowerCase();
  const cod = /\b(cod|cash on delivery|cash)\b/.test(t), pre = /\b(prepaid|pre-paid|online|upi|card|wallet|net ?banking)\b/.test(t);
  return cod && pre ? "both" : cod ? "cod" : pre ? "prepaid" : null;
}
export function normaliseCustomer(s: unknown): Attrs["customer"] {
  const t = String(s ?? "").trim().toLowerCase();
  if (/\b(repeat|returning|regular|existing|old|loyal)\b/.test(t)) return "repeat";
  return /\b(new|first[- ]?time|ftu|first order)\b/.test(t) ? "new" : null;
}

// ---------- city -> state and tier (the city is not kept) ----------
const TIER1 = new Set(["delhi", "new delhi", "gurgaon", "gurugram", "noida", "greater noida", "ghaziabad", "faridabad", "mumbai", "navi mumbai", "thane", "kolkata", "chennai", "bangalore", "bengaluru", "hyderabad", "secunderabad", "pune", "ahmedabad"]);
const TIER2 = new Set(["jaipur", "lucknow", "kanpur", "nagpur", "indore", "bhopal", "patna", "vadodara", "surat", "visakhapatnam", "coimbatore", "kochi", "cochin", "chandigarh", "ludhiana", "agra", "nashik", "vijayawada", "madurai", "varanasi", "meerut", "rajkot", "srinagar", "aurangabad", "dhanbad", "amritsar", "allahabad", "prayagraj", "ranchi", "gwalior", "jabalpur", "jodhpur", "raipur", "kota", "guwahati", "solapur", "hubli", "dharwad", "mysore", "mysuru", "tiruchirappalli", "trichy", "bareilly", "moradabad", "aligarh", "jalandhar", "bhubaneswar", "salem", "warangal", "guntur", "bhiwandi", "saharanpur", "gorakhpur", "bikaner", "amravati", "jamshedpur", "bhilai", "cuttack", "kolhapur", "nanded", "ujjain", "mangalore", "mangaluru", "dehradun", "siliguri", "jamnagar", "jammu", "tirunelveli", "tiruppur", "gaya", "udaipur", "kozhikode", "calicut", "belgaum", "belagavi", "ajmer", "thiruvananthapuram", "trivandrum", "howrah", "panaji", "durgapur", "asansol", "mathura", "firozabad", "noida", "rourkela", "bokaro"]);
const CITY_STATE: Record<string, string[]> = {
  "Delhi": ["delhi", "new delhi"], "Maharashtra": ["mumbai", "navi mumbai", "thane", "pune", "nagpur", "nashik", "virar", "kolhapur", "aurangabad", "mahad", "koregaon bhima", "solapur", "amravati", "nanded", "bhiwandi", "nagpur", "satara", "sangli", "latur", "jalgaon", "akola", "dhule", "ahmednagar", "chandrapur", "panvel", "kalyan", "dombivli", "vasai", "ratnagiri"],
  "Tamil Nadu": ["chennai", "coimbatore", "madurai", "salem", "tiruchirappalli", "trichy", "tirunelveli", "tiruppur", "neyveli", "erode", "vellore", "thanjavur", "kanchipuram", "hosur", "dindigul"],
  "Karnataka": ["bangalore", "bengaluru", "mysore", "mysuru", "mangalore", "mangaluru", "hubli", "dharwad", "belgaum", "belagavi", "kampli", "davangere", "shimoga", "tumkur", "bellary", "gulbarga", "udupi"],
  "Telangana": ["hyderabad", "secunderabad", "warangal", "bhadrachalam", "nalgonda", "karimnagar", "nizamabad", "khammam"],
  "Andhra Pradesh": ["visakhapatnam", "vijayawada", "guntur", "yemmiganur", "nandyal", "tirupati", "nellore", "kurnool", "kakinada", "rajahmundry", "anantapur", "kadapa"],
  "West Bengal": ["kolkata", "howrah", "krishnanagar", "kankinara", "siliguri", "durgapur", "asansol", "bardhaman", "kharagpur", "darjeeling"],
  "Gujarat": ["ahmedabad", "surat", "vadodara", "rajkot", "gandhidham", "viramgam", "kheralu", "godhara", "godhra", "bhuj", "jamnagar", "bhavnagar", "gandhinagar", "anand", "morbi", "mehsana", "navsari", "valsad", "bharuch"],
  "Rajasthan": ["jaipur", "jodhpur", "udaipur", "kota", "banswara", "bhilwara", "bikaner", "ajmer", "bhiwadi", "alwar", "sikar", "sri ganganagar", "chittorgarh", "bharatpur", "pali"],
  "Uttar Pradesh": ["lucknow", "kanpur", "agra", "varanasi", "meerut", "allahabad", "prayagraj", "ballia", "banda", "bulandshahr", "barabanki", "azamgarh", "jaunpur", "aligarh", "bareilly", "moradabad", "saharanpur", "gorakhpur", "firozabad", "mathura", "ghaziabad", "noida", "greater noida", "muzaffarnagar", "jhansi", "etawah", "faizabad", "ayodhya", "sultanpur", "rampur", "shahjahanpur", "hapur", "unnao", "basti"],
  "Madhya Pradesh": ["indore", "bhopal", "gwalior", "jabalpur", "ujjain", "khandwa", "katni", "damoh", "ratlam", "hoshangabad", "betul", "sagar", "rewa", "satna", "dewas", "chhindwara", "narsinghpur", "morena", "vidisha"],
  "Bihar": ["patna", "gaya", "darbhanga", "madhubani", "gopal ganj", "gopalganj", "muzaffarpur", "bhagalpur", "purnia", "arrah", "begusarai", "samastipur", "chapra", "sasaram"],
  "Jharkhand": ["ranchi", "jamshedpur", "dhanbad", "bokaro", "hazaribagh", "deoghar"],
  "Chhattisgarh": ["raipur", "bhilai", "bilaspur", "rajnandgaon", "ambikapur", "durg", "korba", "raigarh"],
  "Haryana": ["gurgaon", "gurugram", "faridabad", "panipat", "ambala", "hisar", "rohtak", "karnal", "sonipat", "bhiwani", "kaithal", "fatehabad", "taraori", "sirsa", "yamunanagar", "jind", "rewari"],
  "Punjab": ["ludhiana", "amritsar", "jalandhar", "patiala", "bathinda", "kot kapura", "mohali", "hoshiarpur", "moga", "pathankot", "firozpur", "faridkot"],
  "Himachal Pradesh": ["shimla", "kullu", "palampur", "solan", "mandi", "dharamshala", "manali", "una", "baddi"],
  "Uttarakhand": ["dehradun", "haridwar", "roorkee", "haldwani", "rishikesh", "rudrapur", "kashipur", "nainital"],
  "Jammu and Kashmir": ["jammu", "srinagar", "udhampur", "kathua", "anantnag", "baramulla"],
  "Kerala": ["kochi", "cochin", "kottayam", "mannarkkad", "thiruvananthapuram", "trivandrum", "kozhikode", "calicut", "thrissur", "kollam", "palakkad", "malappuram", "kannur", "alappuzha"],
  "Odisha": ["bhubaneswar", "cuttack", "rourkela", "berhampur", "sambalpur", "puri", "balasore"],
  "Assam": ["guwahati", "barpeta", "nagaon", "silchar", "dibrugarh", "jorhat", "tezpur"],
  "Goa": ["panaji", "margao", "vasco", "mapusa", "ponda"],
  "Chandigarh": ["chandigarh"],
};
const CITY_TO_STATE = new Map<string, string>();
for (const [state, cities] of Object.entries(CITY_STATE)) for (const c of cities) if (!CITY_TO_STATE.has(c)) CITY_TO_STATE.set(c, state);

/** A city written the way the call sheets write it: "Nalgonda_TG", "Aurangabad (BH)", "New Delhi". Returns what can be worked out, or null. */
export function lookupCity(raw: unknown): { state: string | null; tier: Tier | null } | null {
  let t = String(raw ?? "").trim().toLowerCase();
  if (!t) return null;
  let hint: string | null = null;
  const suffix = /^(.*?)\s*(?:_|\(|-)\s*([a-z]{2})\)?$/.exec(t);
  if (suffix && normaliseState(suffix[2])) { hint = normaliseState(suffix[2]); t = suffix[1]!.trim(); }
  t = t.replace(/[_]+/g, " ").replace(/\s+/g, " ");
  const state = hint ?? CITY_TO_STATE.get(t) ?? null;
  const known = !!state || TIER1.has(t) || TIER2.has(t);
  if (!known) return null; // a town that is not in the list stays unknown: never guessed
  return { state, tier: TIER1.has(t) ? "Tier 1" : TIER2.has(t) ? "Tier 2" : state ? "Tier 3" : null };
}

// ---------- storing ----------
/** Write the values that are given, never replacing a value that came from a stronger source. Returns how many fields changed. */
export function upsertAttributes(db: Db, participantId: string, values: Partial<Attrs>, source: AttrSource): number {
  const cur = (db.prepare("SELECT * FROM participant_attributes WHERE participant_id=?").get(participantId) ?? {}) as Record<string, unknown>;
  const sets: Record<string, unknown> = {}; let changed = 0;
  for (const k of ATTR_KEYS) {
    const v = values[k]; if (v === undefined || v === null) continue;
    const have = cur[k] as unknown, haveSrc = cur[`${k}_src`] as AttrSource | undefined;
    if (have !== null && have !== undefined && haveSrc && RANK[haveSrc] > RANK[source]) continue;
    if (have === v && haveSrc === source) continue;
    sets[k] = v; sets[`${k}_src`] = source; changed++;
  }
  if (!changed) return 0;
  const cols = Object.keys(sets);
  db.prepare(`INSERT INTO participant_attributes(participant_id, ${cols.join(",")}, updated_at) VALUES (?, ${cols.map(() => "?").join(",")}, ?)
    ON CONFLICT(participant_id) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(",")}, updated_at=excluded.updated_at`).run(participantId, ...cols.map((c) => sets[c] as string | number), new Date().toISOString());
  return changed;
}

// ---------- audiences by filter ----------
export type AudienceFilter = { ageMin?: number; ageMax?: number; tiers?: Tier[]; states?: string[]; genders?: NonNullable<Attrs["gender"]>[]; payments?: ("cod" | "prepaid")[]; customers?: NonNullable<Attrs["customer"]>[] };

/** Accepts anything from a request body and keeps only valid parts. */
export function cleanFilter(x: unknown): AudienceFilter {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const list = <T>(v: unknown, ok: (s: string) => T | null): T[] | undefined => { const out = (Array.isArray(v) ? v : []).map((s) => ok(String(s))).filter((s): s is T => s !== null); return out.length ? [...new Set(out)] : undefined; };
  const num = (v: unknown) => { const n = Number(v); return v !== "" && v !== null && v !== undefined && Number.isFinite(n) && n >= 10 && n <= 90 ? Math.round(n) : undefined; };
  const f: AudienceFilter = {};
  const lo = num(o["ageMin"]), hi = num(o["ageMax"]);
  if (lo !== undefined) f.ageMin = lo; if (hi !== undefined) f.ageMax = hi;
  if (f.ageMin !== undefined && f.ageMax !== undefined && f.ageMin > f.ageMax) [f.ageMin, f.ageMax] = [f.ageMax, f.ageMin];
  const tiers = list<Tier>(o["tiers"], (s) => normaliseTier(s)); if (tiers) f.tiers = tiers;
  const states = list<string>(o["states"], (s) => normaliseState(s)); if (states) f.states = states;
  const genders = list<NonNullable<Attrs["gender"]>>(o["genders"], (s) => normaliseGender(s)); if (genders) f.genders = genders;
  const payments = list<"cod" | "prepaid">(o["payments"], (s) => (s === "cod" || s === "prepaid" ? s : null)); if (payments) f.payments = payments;
  const customers = list<NonNullable<Attrs["customer"]>>(o["customers"], (s) => (s === "new" || s === "repeat" ? s : null)); if (customers) f.customers = customers;
  return f;
}
export const isEmptyFilter = (f: AudienceFilter) => Object.keys(f).length === 0;

/** Plain-words name for a filter, for example "Tier 2 · Uttar Pradesh · COD · age 25 to 26". */
export function describeFilter(f: AudienceFilter): string {
  const parts: string[] = [];
  if (f.tiers) parts.push(f.tiers.join(" or "));
  if (f.states) parts.push(f.states.length > 3 ? `${f.states.slice(0, 3).join(", ")} +${f.states.length - 3}` : f.states.join(", "));
  if (f.payments) parts.push(f.payments.length === 2 ? "COD or prepaid" : f.payments[0] === "cod" ? "COD" : "Prepaid");
  if (f.customers) parts.push(f.customers.length === 2 ? "New or repeat" : f.customers[0] === "new" ? "New customers" : "Repeat customers");
  if (f.genders) parts.push(f.genders.map((g) => (g === "male" ? "Men" : g === "female" ? "Women" : "Other")).join(" and "));
  if (f.ageMin !== undefined || f.ageMax !== undefined) parts.push(f.ageMin !== undefined && f.ageMax !== undefined ? (f.ageMin === f.ageMax ? `age ${f.ageMin}` : `age ${f.ageMin} to ${f.ageMax}`) : f.ageMin !== undefined ? `age ${f.ageMin}+` : `age up to ${f.ageMax}`);
  return parts.join(" · ") || "Everyone";
}

const where = (f: AudienceFilter): { sql: string; args: (string | number)[] } => {
  const c: string[] = [], args: (string | number)[] = [];
  const inList = (col: string, v?: string[]) => { if (v?.length) { c.push(`${col} IN (${v.map(() => "?").join(",")})`); args.push(...v); } };
  if (f.ageMin !== undefined) { c.push("age >= ?"); args.push(f.ageMin); }
  if (f.ageMax !== undefined) { c.push("age <= ?"); args.push(f.ageMax); }
  inList("tier", f.tiers); inList("state", f.states); inList("gender", f.genders); inList("customer", f.customers);
  if (f.payments?.length) { c.push(`payment IN (${[...f.payments, "both"].map(() => "?").join(",")})`); args.push(...f.payments, "both"); } // someone who uses both counts for each
  return { sql: c.length ? c.join(" AND ") : "1=1", args };
};

/** Participants who match. Someone whose detail is not known is left out of a filter on that detail, never guessed in. */
export function filterParticipants(db: Db, f: AudienceFilter): string[] {
  const w = where(f);
  return (db.prepare(`SELECT participant_id p FROM participant_attributes WHERE ${w.sql} ORDER BY participant_id`).all(...w.args) as { p: string }[]).map((r) => r.p);
}

export type Facets = {
  total: number; known: Record<AttrKey, number>; age: { min: number; max: number } | null;
  tiers: { value: string; n: number }[]; states: { value: string; n: number }[]; genders: { value: string; n: number }[]; payments: { value: string; n: number }[]; customers: { value: string; n: number }[];
};
export function facets(db: Db): Facets {
  const total = (db.prepare("SELECT COUNT(*) n FROM participants").get() as { n: number }).n;
  const count = (col: string) => (db.prepare(`SELECT ${col} v, COUNT(*) n FROM participant_attributes WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC, v`).all() as { v: string; n: number }[]).map((r) => ({ value: r.v, n: r.n }));
  const known = Object.fromEntries(ATTR_KEYS.map((k) => [k, (db.prepare(`SELECT COUNT(*) n FROM participant_attributes WHERE ${k} IS NOT NULL`).get() as { n: number }).n])) as Record<AttrKey, number>;
  const age = db.prepare("SELECT MIN(age) lo, MAX(age) hi FROM participant_attributes WHERE age IS NOT NULL").get() as { lo: number | null; hi: number | null };
  return { total, known, age: age.lo === null ? null : { min: age.lo, max: age.hi! }, tiers: count("tier"), states: count("state"), genders: count("gender"), payments: count("payment"), customers: count("customer") };
}

export const filterId = (f: AudienceFilter) => "CUS-" + crypto.createHash("sha256").update(JSON.stringify(f, Object.keys(f).sort())).digest("hex").slice(0, 8);
