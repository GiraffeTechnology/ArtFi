import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({ configured:"0x2222222222222222222222222222222222222222" as string | undefined }));
vi.mock("wagmi", () => ({ useAccount:() => ({address:undefined}),useChainId:() => 560048,usePublicClient:() => undefined,useWriteContract:() => ({writeContractAsync:vi.fn()}) }));
vi.mock("@/lib/public-runtime-config", () => ({publicSetting:() => control.configured}));
vi.mock("./admin-safe-console", () => ({AdminSafeConsole:() => null}));
import { CharityEvidenceRecorder } from "./charity-evidence-recorder";

describe("charity evidence review surface", () => {
  beforeEach(() => { control.configured = "0x2222222222222222222222222222222222222222"; });
  it("shows exact role, external-sale review and separate CCHS acceptance boundaries", () => {
    const html = renderToStaticMarkup(createElement(CharityEvidenceRecorder,{tokenId:"7"}));
    expect(html).toContain("DONATION_RECORDER_ROLE");
    expect(html).toContain("not proof of sales");
    expect(html).toContain("separate CCHS acceptance evidence");
    expect(html).toContain("does not sell an edition");
    expect(html).toContain("Do not upload private originals");
    expect(html).toContain("Connect the authorized wallet on Hoodi");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("<img");
  });
  it("does not offer a recorder without the configured editions contract", () => {
    control.configured = undefined;
    const html = renderToStaticMarkup(createElement(CharityEvidenceRecorder,{tokenId:"7"}));
    expect(html).toContain("contract is not configured");
    expect(html).not.toContain("<form");
  });
  it.each(["0","-1","07",(2n**256n).toString()])("refuses invalid series %s", (tokenId) => {
    const html = renderToStaticMarkup(createElement(CharityEvidenceRecorder,{tokenId}));
    expect(html).toContain("series ID is invalid");
    expect(html).not.toContain("<form");
  });
});
