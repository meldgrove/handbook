import { describe, expect, it } from "vitest";
import { isPagePath } from "./app-layout";

describe("isPagePath", () => {
  it("tells pages of a space from the space and its own screens", () => {
    expect(isPagePath("/s/it/network/vpn")).toBe(true);
    expect(isPagePath("/s/it/onboarding")).toBe(true);
    expect(isPagePath("/s/it")).toBe(false);
    expect(isPagePath("/s/it/")).toBe(false);
    expect(isPagePath("/s/it/-/settings")).toBe(false);
    expect(isPagePath("/search")).toBe(false);
  });
});
