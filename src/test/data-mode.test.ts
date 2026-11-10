import { describe, expect, it } from "vitest";
import { isMockSetting } from "@/config/dataMode";

// A build with no setting must talk to the real backend. (A production build once shipped showing demo data because the default was reversed.)
describe("data mode", () => {
  it("uses the real backend unless the demo is explicitly requested", () => {
    expect(isMockSetting(undefined)).toBe(false);
    expect(isMockSetting("")).toBe(false);
    expect(isMockSetting("false")).toBe(false);
    expect(isMockSetting("true")).toBe(true);
  });
});
