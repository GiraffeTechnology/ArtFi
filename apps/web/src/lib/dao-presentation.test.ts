import { describe, expect, it } from "vitest";
import {
  decodeDaoPresentation,
  isDaoPresentation,
  readDaoPresentation,
  sameDaoPresentation,
} from "./dao-presentation";
const profile = () => ({
  version: 1,
  description: "A synthetic DAO profile.",
  avatar: { text: "DAO", palette: "teal" },
});
describe("immutable DAO presentation", () => {
  it("copies validated display data without retaining mutable aliases", () => {
    const input = profile();
    const result = decodeDaoPresentation(input);
    input.avatar.text = "NEW";
    expect(result.avatar.text).toBe("DAO");
    expect(
      sameDaoPresentation(result, {
        ...profile(),
        avatar: { text: "DAO", palette: "teal" },
      }),
    ).toBe(true);
    expect(sameDaoPresentation(result, input)).toBe(false);
  });
  it("accepts multilingual letters, exact byte limits and optional legacy omission", () => {
    expect(
      decodeDaoPresentation({
        ...profile(),
        description: "界".repeat(666),
        avatar: { text: "中文", palette: "gold" },
      }).avatar.text,
    ).toBe("中文");
    expect(
      decodeDaoPresentation({ ...profile(), description: "<".repeat(2000) })
        .description.length,
    ).toBe(2000);
    expect(sameDaoPresentation(undefined, undefined)).toBe(true);
    expect(sameDaoPresentation(undefined, profile())).toBe(false);
    expect(readDaoPresentation(new FormData())).toBeUndefined();
  });
  it("rejects unsupported shapes, controls, palette injection and overlong descriptions", () => {
    for (const value of [
      { ...profile(), version: 2 },
      { ...profile(), owner: "forged" },
      { ...profile(), description: "界".repeat(667) },
      { ...profile(), description: "line\u0000break" },
      { ...profile(), avatar: { text: "FOUR", palette: "teal" } },
      { ...profile(), avatar: { text: "<b>", palette: "teal" } },
      {
        ...profile(),
        avatar: { text: "DAO", palette: "url(https://test.invalid)" },
      },
      {
        ...profile(),
        avatar: {
          text: "DAO",
          palette: "teal",
          src: "https://test.invalid/private",
        },
      },
    ])
      expect(isDaoPresentation(value)).toBe(false);
    const accessor = { ...profile() };
    Object.defineProperty(accessor, "description", {
      get() {
        throw new Error("must not read");
      },
      enumerable: true,
    });
    expect(() => decodeDaoPresentation(accessor)).toThrow();
  });
  it("normalizes form line endings and includes metadata only after explicit inclusion", () => {
    const form = new FormData();
    form.set("daoDescription", " first\r\nsecond ");
    form.set("daoAvatarText", " DAO ");
    form.set("daoAvatarPalette", "violet");
    expect(readDaoPresentation(form)).toBeUndefined();
    form.set("daoPresentation", "include");
    expect(readDaoPresentation(form)).toEqual({
      version: 1,
      description: "first\nsecond",
      avatar: { text: "DAO", palette: "violet" },
    });
  });
});
