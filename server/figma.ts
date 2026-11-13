// Fetch the picture of a Figma frame (or the first few frames of a prototype page) so it can be assessed like an uploaded image.
// Read-only: only the Figma REST API on api.figma.com is called, with a token kept on the server (FIGMA_TOKEN).

export type FigmaFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer>; headers?: { get(name: string): string | null } }>;
export type Frame = { name: string; mimeType: "image/png"; data: Buffer };

/** An error whose message is safe to show to the person using the tool. */
export class FigmaError extends Error { constructor(message: string, readonly status: 422 | 502 = 422) { super(message); } }

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const idOf = (raw: string) => raw.replace(/-/g, ":"); // links write 12-34, the API wants 12:34

/** Accepts figma.com/design, /file, /proto and /board links. A frame is named by node-id (or starting-point-node-id on prototype links). */
export function parseFigmaUrl(url: string): { fileKey: string; nodeIds: string[] } | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== "https:" || !(u.hostname === "figma.com" || u.hostname === "www.figma.com")) return null;
  const m = u.pathname.match(/^\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,40})(?:\/|$)/);
  if (!m) return null;
  const node = u.searchParams.get("node-id") ?? u.searchParams.get("starting-point-node-id");
  return { fileKey: m[1]!, nodeIds: node && /^\d+[-:]\d+$/.test(node) ? [idOf(node)] : [] };
}

const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

export async function fetchFigmaFrames(o: { token: string | undefined; url: string; max: number; fetchImpl?: FigmaFetch }): Promise<Frame[]> {
  const f: FigmaFetch = o.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as any);
  if (!o.token) throw new FigmaError("Figma links need a Figma access token on the server. Ask whoever runs the tool to set FIGMA_TOKEN, or export the frames as images and upload them.");
  const ref = parseFigmaUrl(o.url);
  if (!ref) throw new FigmaError("That doesn't look like a Figma link. Paste a link from figma.com (design, file or prototype).");
  if (o.max < 1) throw new FigmaError("You can assess up to 6 screens at a time.");
  const api = async (path: string) => {
    let r;
    try { r = await f(`https://api.figma.com${path}`, { headers: { "X-Figma-Token": o.token! } }); } catch { throw new FigmaError("Couldn't reach Figma from the server. Check its network access to api.figma.com.", 502); }
    if (r.status === 403) throw new FigmaError("Figma won't let the access token open this file. Share the file with the Figma account that owns the token, or upload exported images instead.");
    if (r.status === 404) throw new FigmaError("Figma couldn't find that file or frame. Check the link.");
    if (r.status === 429) throw new FigmaError("Figma is rate limiting requests. Wait a minute and try again.", 502);
    if (!r.ok) throw new FigmaError(`Figma returned an error (${r.status}).`, 502);
    return r.json();
  };

  // Which frames: the one named in the link, otherwise the first frames of the file's first page.
  let targets: { id: string; name: string }[] = [];
  if (ref.nodeIds.length) {
    const j = await api(`/v1/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeIds.join(","))}&depth=1`);
    targets = ref.nodeIds.map((id) => ({ id, name: String(j?.nodes?.[id]?.document?.name ?? id) }));
    if (!targets.length || ref.nodeIds.every((id) => !j?.nodes?.[id])) throw new FigmaError("Figma couldn't find that frame in the file. Check the link.");
  } else {
    const j = await api(`/v1/files/${ref.fileKey}?depth=2`);
    const page = j?.document?.children?.[0];
    targets = ((page?.children ?? []) as { id: string; name: string; type: string }[]).filter((c) => FRAME_TYPES.has(c.type)).map((c) => ({ id: c.id, name: c.name })).slice(0, o.max);
    if (!targets.length) throw new FigmaError("That Figma file has no frames on its first page. Link to a specific frame instead (right-click it, then Copy link to selection).");
  }
  targets = targets.slice(0, o.max);

  const imgs = await api(`/v1/images/${ref.fileKey}?ids=${encodeURIComponent(targets.map((t) => t.id).join(","))}&format=png&scale=2`);
  const frames: Frame[] = [];
  for (const t of targets) {
    const src: unknown = imgs?.images?.[t.id];
    if (typeof src !== "string") throw new FigmaError(`Figma couldn't draw "${t.name}". Try a different frame.`);
    let host = ""; try { const s = new URL(src); host = s.protocol === "https:" ? s.hostname : ""; } catch { /* invalid */ }
    if (!(host.endsWith(".amazonaws.com") || host.endsWith(".figma.com") || host === "figma.com")) throw new FigmaError("Figma returned an unexpected image address.", 502);
    let r; try { r = await f(src); } catch { throw new FigmaError("Couldn't download the frame image from Figma.", 502); }
    if (!r.ok) throw new FigmaError("Couldn't download the frame image from Figma.", 502);
    const data = Buffer.from(await r.arrayBuffer());
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new FigmaError(`"${t.name}" is too large to assess (over 10 MB). Link to a smaller frame.`);
    frames.push({ name: t.name, mimeType: "image/png", data });
  }
  return frames;
}
