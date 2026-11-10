import type { ChatMessage } from "@/types/research";

type Reply = Omit<ChatMessage, "id" | "from">;
export function personaReply(personaId: string, text: string): Reply {
  const topic = text.toLowerCase();
  if (personaId === "convenience-seeker") return { text: "My profile points toward a quick, predictable purchase, but I don’t have linked evidence to answer that specific question. I’d rather leave my reaction open than invent one.", label: "no_evidence", evidenceIds: [], suggestedStudy: "Explore this question with participants matching the Convenience Seeker profile." };
  if (/genuine|real|trust|credible|promotion|wording/.test(topic)) {
    if (personaId === "trust-conscious") return { text: "I want to know what I’ll actually pay, when it will arrive, and how returns work. Clear details reassure me more than a promotion pushing me to hurry.", label: "evidence", evidenceIds: ["e3", "e6", "e13"] };
    return { text: "I notice the saving first, but I want to see it in rupees and know the final total. A huge discount makes me pause: was the original price raised to make the deal look better?", label: "evidence", evidenceIds: ["e1", "e3", "e10", "e11"] };
  }
  if (/timer|countdown|urgency|limited time/.test(topic)) {
    return { text: personaId === "trust-conscious" ? "A countdown can feel like pressure to me. I’d rather check the price and delivery details than rush. The research is mixed, though—not everyone reacts the same way." : "A timer might make me feel I should hurry, but I still want to compare prices. I’d wonder whether it really ends when it says it does. Some people in the research ignored it altogether.", label: "evidence", evidenceIds: ["e8", "e9"] };
  }
  return { text: "I can’t tell you my preference on that—the research behind my persona doesn’t cover it. I’d rather leave that open than make something up.", label: "no_evidence", evidenceIds: [], suggestedStudy: "Ask about this topic in a short preference study with participants matching this persona." };
}