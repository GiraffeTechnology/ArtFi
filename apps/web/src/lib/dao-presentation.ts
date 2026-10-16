export const daoAvatarPalettes = ["teal", "violet", "gold", "rose", "slate"] as const;
export type DaoAvatarPalette = (typeof daoAvatarPalettes)[number];
export type DaoPresentation = {
  version: 1;
  description: string;
  avatar: { text: string; palette: DaoAvatarPalette };
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value: Record<string, unknown>, fields: string[]) {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor;
  });
}
const invalid = () => new Error("DAO presentation must use at most 2000 UTF-8 description bytes, one to three letters or numbers, and an available avatar colour.");
export function decodeDaoPresentation(value: unknown): DaoPresentation {
  if (!object(value) || !exact(value, ["version", "description", "avatar"])) throw invalid();
  const avatar = value.avatar;
  if (value.version !== 1 || typeof value.description !== "string" ||
    new TextEncoder().encode(value.description).byteLength > 2000 ||
    /[\uD800-\uDFFF]/u.test(value.description) ||
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(value.description) ||
    !object(avatar) || !exact(avatar, ["text", "palette"]) ||
    typeof avatar.text !== "string" || !/^[\p{L}\p{N}]{1,3}$/u.test(avatar.text) ||
    !daoAvatarPalettes.some((palette) => palette === avatar.palette)) throw invalid();
  return {
    version: 1, description: value.description,
    avatar: { text: avatar.text, palette: avatar.palette as DaoAvatarPalette },
  };
}
export function isDaoPresentation(value: unknown): value is DaoPresentation {
  try { decodeDaoPresentation(value); return true; } catch { return false; }
}
export function sameDaoPresentation(left: unknown, right: unknown) {
  if (left === undefined && right === undefined) return true;
  try {
    const a = decodeDaoPresentation(left), b = decodeDaoPresentation(right);
    return a.description === b.description && a.avatar.text === b.avatar.text && a.avatar.palette === b.avatar.palette;
  } catch { return false; }
}
export function readDaoPresentation(form: Pick<FormData, "get">): DaoPresentation | undefined {
  if (form.get("daoPresentation") !== "include") return undefined;
  return decodeDaoPresentation({
    version: 1,
    description: String(form.get("daoDescription") ?? "").replaceAll("\r\n", "\n").trim(),
    avatar: {
      text: String(form.get("daoAvatarText") ?? "").trim(),
      palette: String(form.get("daoAvatarPalette") ?? ""),
    },
  });
}
