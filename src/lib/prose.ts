/** Evidence numbers belong in the citations, not in the sentence. Answers saved before this was fixed may still contain things like "#575, #1824". */
export const stripEvidenceMarkers = (text: string) =>
  text.replace(/\s*[[(]\s*#?\d+(?:\s*[,;]\s*#?\d+)*\s*[\])]/g, "")
    .replace(/(?:\s*(?:,|;|and|&)\s*)?\s#\d+(?:\s*(?:,|;|and|&)\s*#\d+)*/g, "")
    .replace(/^#\d+(?:\s*(?:,|;|and|&)\s*#\d+)*\s*/, "")
    .replace(/\s{2,}/g, " ").replace(/\s+([.,;!?])/g, "$1").replace(/,\s*([.!?])/g, "$1").trim();

/** Every piece of written text in a value, cleaned. Keys named in `skip` (such as the person's own attached material) are left exactly as they are. */
export function cleanProse<T>(v: T, skip: string[] = ["attachments"]): T {
  if (typeof v === "string") return stripEvidenceMarkers(v) as T;
  if (Array.isArray(v)) return v.map((x) => cleanProse(x, skip)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, skip.includes(k) ? x : cleanProse(x, skip)])) as T;
  return v;
}
