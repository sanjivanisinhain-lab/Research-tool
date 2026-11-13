// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseFigmaUrl } from "../figma";

describe("parseFigmaUrl", () => {
  const K = "AbCdEfGhIjKlMn";
  it("reads design, file, proto and board links, with the frame from node-id or the prototype start", () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${K}/My-file?node-id=12-34&t=x`)).toEqual({ fileKey: K, nodeIds: ["12:34"] });
    expect(parseFigmaUrl(`https://figma.com/file/${K}/My-file`)).toEqual({ fileKey: K, nodeIds: [] });
    expect(parseFigmaUrl(`https://www.figma.com/proto/${K}/Flow?starting-point-node-id=7%3A8`)).toEqual({ fileKey: K, nodeIds: ["7:8"] }); // a prototype link opens at its starting frame
    expect(parseFigmaUrl(`https://www.figma.com/proto/${K}/Flow?starting-point-node-id=7-8&node-id=1-2`)).toEqual({ fileKey: K, nodeIds: ["1:2"] });
    expect(parseFigmaUrl(`https://www.figma.com/board/${K}/Jam`)?.fileKey).toBe(K);
  });
  it("refuses anything that is not a figma.com https link", () => {
    for (const bad of ["", "not a url", `http://figma.com/design/${K}/x`, `https://figma.com.evil.test/design/${K}/x`, `https://evil.test/design/${K}/x`, "https://www.figma.com/community/file/1", `https://www.figma.com/design/short/x`])
      expect(parseFigmaUrl(bad)).toBeNull();
  });
});
