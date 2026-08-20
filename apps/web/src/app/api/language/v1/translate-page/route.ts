import { isTranslatableSource, isUiLocale } from "@/lib/language";
import { translatePageTexts } from "@/lib/language-server";

const MAX_REQUEST_BYTES = 20_000;
const MAX_TEXTS = 64;

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return Response.json(
        { error: { code: "REQUEST_TOO_LARGE" } },
        { status: 413 },
      );
    }

    const body = (await request.json()) as {
      target_language?: unknown;
      texts?: unknown;
    };
    if (
      !isUiLocale(body.target_language) ||
      body.target_language === "en" ||
      !Array.isArray(body.texts) ||
      body.texts.length === 0 ||
      body.texts.length > MAX_TEXTS ||
      body.texts.some(
        (text) => typeof text !== "string" || !isTranslatableSource(text),
      ) ||
      JSON.stringify(body).length > MAX_REQUEST_BYTES
    ) {
      return Response.json(
        { error: { code: "INVALID_TRANSLATION_REQUEST" } },
        { status: 400 },
      );
    }

    const texts = body.texts as string[];
    const result = await translatePageTexts(texts, body.target_language);
    return Response.json({
      source_language: "en",
      target_language: body.target_language,
      ...result,
    });
  } catch {
    return Response.json(
      { error: { code: "TRANSLATION_UNAVAILABLE" } },
      { status: 503 },
    );
  }
}
