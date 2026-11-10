import { describe, expect, it } from "vitest";
import { mockApi } from "@/api/mock";
import { personaReply } from "@/api/personaReplies";

describe("research client rules", () => {
  it("supplies simulated CX audio with synchronized original cues and separate translation", async () => {
    const evidence = await mockApi.getEvidence(["e3", "e7", "e1"]);
    const cx = evidence.filter((e) => e.sourceType === "cx_call");
    expect(cx).toHaveLength(2);
    for (const item of cx) {
      expect(item.audio?.simulated).toBe(true);
      expect(item.audio?.cues.map((c) => c.text).join(" ")).toBe(item.quote);
      expect(item.audio?.url).toMatch(/\.mp3$/);
      expect(item.translation).not.toBe(item.quote);
      expect(item.audio?.cues.at(-1)?.end).toBe(item.audio?.duration);
    }
    expect(evidence.find((e) => e.id === "e1")?.audio).toBeUndefined();
  });
  it("preserves pasted CX material without adding it to research evidence", async () => {
    const result = await mockApi.ask({ question: "Why abandon carts?", audience: [], mode: "combine", attachments: [{ name: "Pasted CX transcript", kind: "transcript", text: "A supplied caller note" }] });
    const answer = await mockApi.getAnswer(result.id);
    expect(answer?.attachments?.[0]?.text).toBe("A supplied caller note");
    expect(await mockApi.getEvidence(["A supplied caller note"])).toEqual([]);
  });
  it("deduplicates overlapping persona and segment membership", async () => {
    const audiences = await mockApi.listAudiences();
    const selected = audiences.filter((a) => ["tier-2", "deal-driven"].includes(a.ref.id)).map((a) => a.ref);
    expect(await mockApi.countParticipants(selected)).toBe(36);
  });
  it("keeps unsupported persona topics without evidence", () => {
    const reply = personaReply("deal-driven", "Would you prefer dark mode?");
    expect(reply.label).toBe("no_evidence");
    expect(reply.evidenceIds).toEqual([]);
  });
  it("retains supporting citations for conversational persona responses", async () => {
    const reply = personaReply("trust-conscious", "What feels trustworthy?");
    expect(reply.evidenceIds).toEqual(["e3", "e6", "e13"]);
    const evidence = await mockApi.getEvidence(reply.evidenceIds ?? []);
    expect(evidence.map((e) => e.participantId)).toEqual(["P033", "P029", "P036"]);
  });
  it("returns simulated inspectable sources and preserves said versus did", async () => {
    const evidence = await mockApi.getEvidence(["e1", "e9"]);
    expect(evidence.map((e) => e.kind)).toEqual(["said", "did"]);
    expect(evidence.map((e) => e.sourceContext?.simulated)).toEqual([true, true]);
    expect(evidence.map((e) => e.sourceContext?.reference)).toEqual(["interview-P018-e1", "usability-P027-e9"]);
  });
});