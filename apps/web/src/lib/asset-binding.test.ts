import { describe, expect, it } from "vitest";

import { assetDeploymentBinding } from "./asset-binding";

const address = "0x00000000000000000000000000000000000000c0";

describe("assetDeploymentBinding", () => {
  it("binds the deployment to the page it names", () => {
    expect(
      assetDeploymentBinding("blue-hour-archive", "blue-hour-archive", address),
    ).toEqual({ bound: true, boundElsewhere: false });
  });

  /**
   * The finding this exists for. `AssetDetail` is shared by every slug in `lib/catalog.ts`, so a
   * deployment read from the environment alone used to appear beneath all six invented artworks at
   * once — one real holding offered under six different titles, and a holder able to sign away an
   * asset the page did not describe.
   */
  it("never binds a deployment to another page", () => {
    expect(
      assetDeploymentBinding("material-memory", "blue-hour-archive", address),
    ).toEqual({ bound: false, boundElsewhere: true });
  });

  // A deployment that names nothing belongs nowhere. This is the case that used to leak, and the
  // one where "belongs to another page" would be a lie — there is no other page to point at.
  it("binds nowhere when the deployment names no slug", () => {
    for (const named of [undefined, "", "   "]) {
      expect(
        assetDeploymentBinding("blue-hour-archive", named, address),
      ).toEqual({ bound: false, boundElsewhere: false });
    }
  });

  it("reports nothing deployed as neither bound nor elsewhere", () => {
    for (const configured of [undefined, "", "   "]) {
      expect(
        assetDeploymentBinding(
          "blue-hour-archive",
          "blue-hour-archive",
          configured,
        ),
      ).toEqual({ bound: false, boundElsewhere: false });
    }
  });

  // A page with no slug of its own cannot be the named one.
  it("does not bind a page that has no slug", () => {
    expect(
      assetDeploymentBinding(undefined, "blue-hour-archive", address),
    ).toEqual({ bound: false, boundElsewhere: true });
    expect(assetDeploymentBinding("  ", "blue-hour-archive", address)).toEqual({
      bound: false,
      boundElsewhere: true,
    });
  });

  // Surrounding whitespace in an environment value is an accident, not a different slug.
  it("compares slugs after trimming", () => {
    expect(
      assetDeploymentBinding(
        "blue-hour-archive",
        "  blue-hour-archive  ",
        address,
      ).bound,
    ).toBe(true);
  });

  // Slugs are case-sensitive route segments; two that differ in case are two different routes.
  it("does not treat a differently cased slug as the same page", () => {
    expect(
      assetDeploymentBinding("blue-hour-archive", "Blue-Hour-Archive", address),
    ).toEqual({ bound: false, boundElsewhere: true });
  });
});
