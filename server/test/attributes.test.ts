// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { cleanFilter, describeFilter, facets, filterParticipants, lookupCity, normaliseAge, normaliseCustomer, normaliseGender, normalisePayment, normaliseState, normaliseTier, upsertAttributes } from "../attributes";
import { fillAttributes, needsAttributes, verify } from "../ai/attributes";
import { MockProvider } from "../ai/provider";
import type { SheetsClient } from "../google";
import { createLink, syncSheet } from "../sheets";

describe("reading what people type", () => {
  it("normalises ages, tiers, states, gender, payment and customer type, and leaves unclear values unknown", () => {
    expect([normaliseAge("28"), normaliseAge("28 yrs"), normaliseAge("25-34"), normaliseAge("7"), normaliseAge("")]).toEqual([28, 28, null, null, null]);
    expect([normaliseTier("Tier 2"), normaliseTier("t3"), normaliseTier("2"), normaliseTier("Metro"), normaliseTier("big")]).toEqual(["Tier 2", "Tier 3", "Tier 2", "Tier 1", null]);
    expect([normaliseState("UP"), normaliseState("uttar pradesh"), normaliseState("Tamilnadu"), normaliseState("J&K"), normaliseState("Atlantis")]).toEqual(["Uttar Pradesh", "Uttar Pradesh", "Tamil Nadu", "Jammu and Kashmir", null]);
    expect([normaliseGender("F"), normaliseGender("Male"), normaliseGender("?")]).toEqual(["female", "male", null]);
    expect([normalisePayment("COD"), normalisePayment("Prepaid"), normalisePayment("COD and UPI"), normalisePayment("n/a")]).toEqual(["cod", "prepaid", "both", null]);
    expect([normaliseCustomer("First-time user"), normaliseCustomer("Repeat"), normaliseCustomer("hmm")]).toEqual(["new", "repeat", null]);
  });
  it("turns a city into a state and a tier, the way the call sheets write cities, and never guesses a town it does not know", () => {
    expect(lookupCity("New Delhi")).toEqual({ state: "Delhi", tier: "Tier 1" });
    expect(lookupCity("Jaipur")).toEqual({ state: "Rajasthan", tier: "Tier 2" });
    expect(lookupCity("Banswara")).toEqual({ state: "Rajasthan", tier: "Tier 3" });
    expect(lookupCity("Nalgonda_TG")).toMatchObject({ state: "Telangana" }); // a state code after the city is used
    expect(lookupCity("Aurangabad (BH)")).toMatchObject({ state: "Bihar" }); // so Aurangabad in Bihar is not mistaken for the one in Maharashtra
    expect(lookupCity("Pratapgarh")).toBeNull(); // two states have one: left unknown
    expect(lookupCity("")).toBeNull();
  });
});

describe("where a detail came from decides what can replace it", () => {
  it("lets the sheet beat the notes, and the notes beat the city, never the other way round", () => {
    const db = openDb(":memory:"); db.exec("INSERT INTO studies VALUES ('S','s','p','x'); INSERT INTO participants VALUES ('P1','S','{}','x')");
    upsertAttributes(db, "P1", { tier: "Tier 3", state: "Rajasthan" }, "city");
    upsertAttributes(db, "P1", { tier: "Tier 2" }, "notes");
    upsertAttributes(db, "P1", { tier: "Tier 3", age: 30 }, "city"); // weaker: ignored for tier, new for age
    expect(db.prepare("SELECT tier, tier_src, age, age_src, state FROM participant_attributes").get()).toMatchObject({ tier: "Tier 2", tier_src: "notes", age: 30, age_src: "city", state: "Rajasthan" });
    upsertAttributes(db, "P1", { tier: "Tier 1" }, "sheet");
    expect(db.prepare("SELECT tier, tier_src FROM participant_attributes").get()).toMatchObject({ tier: "Tier 1", tier_src: "sheet" });
    upsertAttributes(db, "P1", { tier: "Tier 3" }, "notes");
    expect(db.prepare("SELECT tier FROM participant_attributes").get()).toMatchObject({ tier: "Tier 1" });
  });
});

function people(db: Db) {
  db.exec("INSERT INTO studies VALUES ('S','s','p','x')");
  const rows: [string, Parameters<typeof upsertAttributes>[2]][] = [
    ["P1", { age: 25, tier: "Tier 2", state: "Uttar Pradesh", payment: "cod", gender: "female", customer: "new" }],
    ["P2", { age: 26, tier: "Tier 2", state: "Uttar Pradesh", payment: "prepaid", gender: "male", customer: "repeat" }],
    ["P3", { age: 40, tier: "Tier 3", state: "Uttar Pradesh", payment: "both" }],
    ["P4", { tier: "Tier 2", state: "Rajasthan", payment: "cod" }], // age unknown
    ["P5", { age: 25, tier: "Tier 1", state: "Delhi", payment: "cod" }],
  ];
  for (const [id, a] of rows) { db.prepare("INSERT INTO participants VALUES (?,?,?,?)").run(id, "S", "{}", "x"); upsertAttributes(db, id, a, "sheet"); }
  db.exec("INSERT INTO participants VALUES ('P6','S','{}','x')"); // nothing known about this one
}

describe("audiences picked by details", () => {
  it("matches on every chosen detail, counts people who use both ways of paying for each, and leaves out people whose detail is unknown", () => {
    const db = openDb(":memory:"); people(db);
    expect(filterParticipants(db, cleanFilter({ states: ["UP"], ageMin: 25, ageMax: 26 }))).toEqual(["P1", "P2"]);
    expect(filterParticipants(db, cleanFilter({ states: ["Uttar Pradesh"], payments: ["cod"] }))).toEqual(["P1", "P3"]); // P3 pays both ways
    expect(filterParticipants(db, cleanFilter({ tiers: ["Tier 2"], payments: ["prepaid"] }))).toEqual(["P2"]);
    expect(filterParticipants(db, cleanFilter({ ageMin: 25 }))).toEqual(["P1", "P2", "P3", "P5"]); // P4 has no age: not guessed in
    expect(filterParticipants(db, cleanFilter({ genders: ["female"], customers: ["new"] }))).toEqual(["P1"]);
  });
  it("ignores invalid input, swaps a backwards age range, and names the audience in plain words", () => {
    const f = cleanFilter({ ageMin: 30, ageMax: 20, tiers: ["Tier 2", "nonsense"], states: ["UP", "Atlantis"], payments: ["cod", "bitcoin"], genders: [], extra: 1 });
    expect(f).toEqual({ ageMin: 20, ageMax: 30, tiers: ["Tier 2"], states: ["Uttar Pradesh"], payments: ["cod"] });
    expect(describeFilter(f)).toBe("Tier 2 · Uttar Pradesh · COD · age 20 to 30");
    expect(describeFilter({})).toBe("Everyone");
  });
  it("reports what is known, for the builder", () => {
    const db = openDb(":memory:"); people(db);
    const f = facets(db);
    expect(f).toMatchObject({ total: 6, age: { min: 25, max: 40 }, known: { age: 4, tier: 5, state: 5 } });
    expect(f.states[0]).toEqual({ value: "Uttar Pradesh", n: 3 });
  });
});

describe("filling blanks from the notes", () => {
  const TEXT = "PROFILE\n Age 28, Tier 2 (Udaipur, Rajasthan). Male. Buys for himself.\n PAYMENT\n Pays cash on delivery because he does not trust prepaid.";
  const seedText = (db: Db, id: string, text: string) => {
    db.exec("INSERT OR IGNORE INTO studies VALUES ('S','s','p','x')");
    db.prepare("INSERT INTO participants VALUES (?,?,?,?)").run(id, "S", "{}", "x");
    db.prepare("INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES (?,?,?,?,?,?,?)").run("SRC-" + id, "S", id, "cx_call", "researcher_notes", "t", "x");
    db.prepare("INSERT INTO utterances(source_id,participant_id,speaker,seq,text) VALUES (?,?,?,?,?)").run("SRC-" + id, id, "note", 0, text);
  };
  it("keeps a detail only when its quote is really in the text and says what the detail says", () => {
    const ok = verify(TEXT, { id: "P1", age: 28, age_quote: "Age 28", tier: "Tier 2", tier_quote: "Tier 2 (Udaipur", state: "Rajasthan", state_quote: "Udaipur, Rajasthan", gender: "male", gender_quote: "Male.", payment: "cod", payment_quote: "Pays cash on delivery" });
    expect(ok).toEqual({ age: 28, tier: "Tier 2", state: "Rajasthan", gender: "male", payment: "cod" });
    const bad = verify(TEXT, { id: "P1", age: 35, age_quote: "Age 35", tier: "Tier 1", tier_quote: "Tier 2 (Udaipur", gender: "female", gender_quote: "Male.", payment: "prepaid", payment_quote: "Pays cash on delivery", state: "Gujarat", state_quote: "he lives in Gujarat" });
    expect(bad).toEqual({}); // an invented quote, a value that disagrees with its quote, a quote from nowhere
  });
  it("reads only people with blanks, adds what is clear, never asks again, and asks again when the text changes", async () => {
    const db = openDb(":memory:"); seedText(db, "P1", TEXT); seedText(db, "P2", "no personal details here at all");
    upsertAttributes(db, "P1", { age: 29 }, "sheet");
    let prompt = "";
    const ai = new MockProvider((req) => { prompt = req.prompt; return { people: [{ id: "P1", age: 28, age_quote: "Age 28", tier: "Tier 2", tier_quote: "Tier 2 (Udaipur", gender: "male", gender_quote: "Male." }, { id: "P2", age: 0 }, { id: "PX", tier: "Tier 1", tier_quote: "Tier 1" }] }; });
    expect(needsAttributes(db)).toBe(true);
    const r = await fillAttributes(db, ai);
    expect(r).toEqual({ people: 2, added: 2 }); // tier and gender for P1; its sheet age is kept
    expect(prompt).toContain("=== PERSON P1 ===");
    expect(db.prepare("SELECT age, age_src, tier, tier_src, gender FROM participant_attributes WHERE participant_id='P1'").get()).toMatchObject({ age: 29, age_src: "sheet", tier: "Tier 2", tier_src: "notes", gender: "male" });
    expect(needsAttributes(db)).toBe(false); // both were checked, including the one with nothing to find
    db.prepare("UPDATE participant_attributes SET ai_checked_at=NULL WHERE participant_id='P2'").run(); // new text arrived
    expect(needsAttributes(db)).toBe(true);
  });
});

const HEAD = ["Participant ID", "Name", "Number", "Transcript", "Data available", "Study", "City", "Call date", "Notes (your sheet)", "Age", "Tier", "State", "Payment type"];
function fake(tabs: Record<string, string[][]>): SheetsClient & { tabs: Record<string, string[][]> } {
  const c = { serviceAccountEmail: "r@x", tabs, async spreadsheet() { return { title: "t", tabs: Object.keys(c.tabs).map((t, i) => ({ title: t, gid: String(i), hidden: false })) }; }, async values(_i: string, t: string) { return c.tabs[t]!.map((r) => [...r]); } };
  return c;
}
describe("details from the sheet", () => {
  it("takes them from the columns, fills tier and state from the city when the columns are blank, and never erases a value when a cell is cleared", async () => {
    const db = openDb(":memory:"); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-at-"));
    const g = fake({ Hub: [HEAD,
      ["A-1", "Asha", "", "", "Notes only", "S1", "Banswara", "04-11-2026", "uses cod because trust, no issues", "27", "", "", "COD"],
      ["A-2", "Meena", "", "", "Notes only", "S1", "Jaipur", "04-11-2026", "prefers prepaid, has ordered many times", "", "Tier 3", "UP", ""]] });
    const id = createLink(db, { url: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", name: "x" });
    const opts = { termsPath: path.join(dir, "t.json") };
    await syncSheet(db, g, id, opts); await syncSheet(db, g, id, { ...opts, import: true });
    const a = (pid: string) => db.prepare("SELECT a.* FROM participant_attributes a JOIN sheet_rows r ON r.participant_id=a.participant_id WHERE r.external_id=?").get(pid) as Record<string, unknown>;
    expect(a("A-1")).toMatchObject({ age: 27, age_src: "sheet", payment: "cod", state: "Rajasthan", state_src: "city", tier: "Tier 3", tier_src: "city" });
    expect(a("A-2")).toMatchObject({ tier: "Tier 3", tier_src: "sheet", state: "Uttar Pradesh", state_src: "sheet" }); // the sheet beat what the city said (Jaipur is Tier 2, Rajasthan)
    // a detail changed in the sheet is picked up without reading the text again; a cleared cell leaves the value alone
    g.tabs["Hub"]![1]![9] = "28"; g.tabs["Hub"]![2]![10] = "";
    const r = await syncSheet(db, g, id, opts);
    expect(r).toMatchObject({ edited: 0, unchanged: 2 });
    expect(a("A-1")).toMatchObject({ age: 28 }); expect(a("A-2")).toMatchObject({ tier: "Tier 3" });
    expect(JSON.stringify(db.prepare("SELECT * FROM participant_attributes").all())).not.toMatch(/Banswara|Jaipur|Asha/); // the city is never kept
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("custom audiences over the API", () => {
  let server: Server; let base = ""; let db: Db;
  beforeEach(() => { db = openDb(":memory:"); people(db); server = createApp(db, { auth: { authDisabled: true } }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`; });
  afterEach(() => { server.close(); });
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  it("previews who matches and who could match, then saves, lists, counts and removes an audience", async () => {
    const pv = await (await post("/api/audiences/custom/preview", { filter: { states: ["UP"], ageMin: 25, ageMax: 26 } })).json();
    expect(pv).toMatchObject({ matching: 2, undetermined: 1, total: 6, name: "Uttar Pradesh · age 25 to 26" }); // P6 knows nothing, so it could match; P3 is 40, P4 is Rajasthan, P5 is Delhi
    expect((await (await fetch(`${base}/api/attributes/facets`)).json()).states[0]).toEqual({ value: "Uttar Pradesh", n: 3 });
    expect((await post("/api/audiences/custom", { filter: {} })).status).toBe(400);
    const ref = await (await post("/api/audiences/custom", { filter: { states: ["UP"], ageMin: 25, ageMax: 26 } })).json();
    expect(ref).toMatchObject({ kind: "custom", name: "Uttar Pradesh · age 25 to 26", participants: 2 });
    expect((await (await post("/api/audiences/custom", { filter: { states: ["Uttar Pradesh"], ageMax: 26, ageMin: 25 }, name: "ignored: already saved" })).json()).id).toBe(ref.id); // the same filter is the same audience
    const list = await (await fetch(`${base}/api/audiences`)).json();
    expect(list.find((a: any) => a.ref.id === ref.id)).toMatchObject({ ref: { kind: "custom" }, initials: "CU" });
    expect((await (await post("/api/audiences/count", { audience: [ref] })).json()).count).toBe(2);
    expect((await (await fetch(`${base}/api/audiences/custom/${ref.id}`)).json()).description).toMatch(/Uttar Pradesh · age 25 to 26/);
    expect((await fetch(`${base}/api/audiences/custom/${ref.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/audiences/custom/${ref.id}`)).status).toBe(404);
  });
});
