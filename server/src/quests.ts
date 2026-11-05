import { askJSON } from "./ai.ts";

const INSTRUCTIONS = `You write side quests for a party game played in person by a group of friends. \
Each quest is a short, concrete dare or mission a player can complete in a few minutes \
and prove with a single photo. Match the group's vibe — their humor, boldness, setting \
and level of chaos — as shown by the quests they wrote themselves. Keep quests legal, \
safe, and kind to strangers. Each quest is one sentence, under 90 characters, \
imperative voice, no numbering or emoji.`;

const SCHEMA = {
  type: "object",
  properties: { quests: { type: "array", items: { type: "string" } } },
  required: ["quests"],
  additionalProperties: false,
} as const;

/**
 * Writes `count` new quests in the vibe of the group's own. Uses Workers AI when
 * the binding is present; otherwise (or on any failure) the offline deck.
 */
export async function writeQuests(ai: Ai | undefined, count: number, examples: string[], avoiding: string[]): Promise<string[]> {
  if (ai) {
    try {
      const quests = await askAI(ai, count, examples, avoiding);
      if (quests.length) return quests;
    } catch (error) {
      console.error("AI quest generation failed:", error);
    }
  }
  return offlineQuests(count, [...examples, ...avoiding]);
}

async function askAI(ai: Ai, count: number, examples: string[], avoiding: string[]) {
  const exampleList = examples.length
    ? examples.map((q) => `- ${q}`).join("\n")
    : "(The group hasn't written any yet — go for playful, low-stakes chaos.)";
  const avoidList = avoiding.length
    ? `\n\nAlready in play (don't repeat or closely paraphrase):\n${avoiding.map((q) => `- ${q}`).join("\n")}`
    : "";
  const input = `Quests this group wrote:\n${exampleList}${avoidList}\n\nWrite ${count} new quests in the same vibe.`;

  const { quests } = await askJSON<{ quests: unknown }>(ai, INSTRUCTIONS, input, SCHEMA);
  if (!Array.isArray(quests)) throw new Error("AI returned no quest list");
  return quests
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, count);
}

const OFFLINE_DECK = [
  "Get a stranger to teach you a secret handshake",
  "Recreate a famous painting using only things in your pockets",
  "Find something older than everyone in the group combined",
  "Convince someone to swap an object with you",
  "Take a dramatic album-cover shot in the nearest doorway",
  "Find a dog and learn its full name",
  "Build a tower of five unrelated objects",
  "Get a high five from someone wearing a hat",
  "Find the most aggressively orange thing nearby",
  "Strike a superhero pose on top of something (safely)",
  "Order something using only a fake accent",
  "Find a sign with a typo",
  "Make a tiny shrine to a random object",
  "Get three strangers to point at the sky",
  "Photograph your reflection in something that isn't a mirror",
  "Find a plant that looks like a friend in the group",
  "Learn one word in a language you don't speak from a stranger",
  "Do your best runway walk across a crosswalk",
  "Find something shaped like a letter in your name",
  "Get a compliment from someone you've never met",
];

function offlineQuests(count: number, used: string[]): string[] {
  const seen = new Set(used.map((q) => q.toLowerCase()));
  return OFFLINE_DECK.filter((q) => !seen.has(q.toLowerCase()))
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
}
