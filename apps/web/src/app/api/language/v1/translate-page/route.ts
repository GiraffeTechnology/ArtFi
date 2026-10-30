import { isTranslatableSource, isUiLocale } from "@/lib/language";
import { translatePageTexts } from "@/lib/language-server";
import {
  MAX_TRANSLATION_REQUEST_BYTES,
  readTranslationJson,
  TranslationJsonTooLargeError,
} from "@/lib/translation-json";

const MAX_TEXTS = 64;

export async function POST(request: Request) {
  try {
    const body = (await readTranslationJson(
      request,
      MAX_TRANSLATION_REQUEST_BYTES,
      request.signal,
    )) as null | {
      target_language?: unknown;
      texts?: unknown;
    };
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !isUiLocale(body.target_language) ||
      !Array.isArray(body.texts) ||
      body.texts.length === 0 ||
      body.texts.length > MAX_TEXTS ||
      body.texts.some(
        (text) => typeof text !== "string" || !isTranslatableSource(text),
      ) ||
      JSON.stringify(body).length > MAX_TRANSLATION_REQUEST_BYTES
    ) {
      return Response.json(
        { error: { code: "INVALID_TRANSLATION_REQUEST" } },
        { status: 400 },
      );
    }

    const texts = body.texts as string[];
    const result = await translatePageTexts(texts, body.target_language);
    return Response.json({
      source_language: "auto",
      target_language: body.target_language,
      ...result,
    });
  } catch (error) {
    if (error instanceof TranslationJsonTooLargeError)
      return Response.json(
        { error: { code: "REQUEST_TOO_LARGE" } },
        { status: 413 },
      );
    if (error instanceof SyntaxError)
      return Response.json(
        { error: { code: "INVALID_TRANSLATION_REQUEST" } },
        { status: 400 },
      );
    return Response.json(
      { error: { code: "TRANSLATION_UNAVAILABLE" } },
      { status: 503 },
    );
  }
}
