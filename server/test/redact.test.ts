// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeRedactor } from "../redact";

describe("redaction never uses filler words as names", () => {
  const redact = makeRedactor({ names: ["Ravi Kumar", "Name not given", "New caller", "Unknown", "Asha"], places: ["Jaipur", "Not given", "NA"] });
  it("keeps ordinary words ('not', 'given', 'new', 'name') in the text, and still removes real names and cities", () => {
    const r = redact("Ravi said he did not order the new saree, the name was not given. Asha lives in Jaipur.");
    expect(r.text).toBe("[NAME] said he did not order the new saree, the name was not given. [NAME] lives in [CITY].");
    expect(r.counts).toMatchObject({ names: 2, places: 1 });
  });
  it("is safe to run twice: markers are not mistaken for names", () => {
    const once = redact("Ravi Kumar called from Jaipur.").text;
    expect(redact(once).text).toBe(once);
    expect(once).toBe("[NAME] called from [CITY].");
    expect(once).not.toContain("[[");
  });
});
