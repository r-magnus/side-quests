/**
 * Cloudflare Workers AI (the `AI` binding in wrangler.jsonc): no API key, free daily allowance.
 *
 * Stopgap: until f75403e this called OpenAI (gpt-5.4-mini, strict json_schema via the
 * Responses API), which matched a group's humor noticeably better. To bring that back,
 * see quests.ts / ratings.ts at f75403e — the prompts and schemas are unchanged.
 */
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Asks for JSON matching `schema`. Throws on any failure; callers fall back offline. */
export async function askJSON<T>(ai: Ai, system: string, user: string, schema: object): Promise<T> {
  const result = (await ai.run(AI_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: 2048,
  })) as { response?: unknown };
  // JSON mode usually returns the parsed object, but may return it as text.
  const out = typeof result.response === "string" ? JSON.parse(result.response) : result.response;
  if (!out || typeof out !== "object") throw new Error("Workers AI returned no JSON");
  return out as T;
}
