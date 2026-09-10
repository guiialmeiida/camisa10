import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Team } from "./types.ts";

export const teamRecordSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  nicknames: z.array(z.string().min(1)),
  aliases: z.array(z.string().min(1)),
  footballDataId: z.number().int().positive(),
});

export type TeamRecord = z.infer<typeof teamRecordSchema>;

const TEAMS_PATH = path.join(import.meta.dirname, "teams.json");

/** lowercase, NFD + diacritic removal, whitespace collapse — so "Atlético-MG", "atletico mg"
 * and "ATLETICO-MG" all land on the same key. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface TeamIndex {
  records: TeamRecord[];
  byNormalizedKey: Map<string, string>; // normalized name/alias -> team id
  byFootballDataId: Map<number, string>;
}

let cachedIndex: TeamIndex | undefined;

async function loadIndex(): Promise<TeamIndex> {
  if (cachedIndex) return cachedIndex;

  const raw = await readFile(TEAMS_PATH, "utf-8");
  const parsed = z.array(teamRecordSchema).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`invalid teams.json at ${TEAMS_PATH}:\n${z.prettifyError(parsed.error)}`);
  }

  const byNormalizedKey = new Map<string, string>();
  const byFootballDataId = new Map<number, string>();

  for (const record of parsed.data) {
    // resolveTeamId only ever looks at name + aliases, never nicknames: "Tricolor"
    // belongs to four different clubs, "Timão" to one — a nickname disambiguates with
    // the question's context (that's the extractEntity prompt's job), not a Map alone.
    for (const key of [record.name, ...record.aliases].map(normalize)) {
      const existing = byNormalizedKey.get(key);
      if (existing !== undefined && existing !== record.id) {
        throw new Error(
          `teams.json: normalized key "${key}" collides between "${existing}" and "${record.id}"`,
        );
      }
      byNormalizedKey.set(key, record.id);
    }
    byFootballDataId.set(record.footballDataId, record.id);
  }

  cachedIndex = { records: parsed.data, byNormalizedKey, byFootballDataId };
  return cachedIndex;
}

/** Known teams, without the source-mapping fields. This is what goes in `Facts.teams`. */
export async function listTeams(): Promise<Team[]> {
  const { records } = await loadIndex();
  return records.map((record) => ({ id: record.id, name: record.name, nicknames: record.nicknames }));
}

/** "SE Palmeiras" | "Palmeiras SP" | "palmeiras" -> "palmeiras". Unknown -> null. */
export async function resolveTeamId(name: string): Promise<string | null> {
  const { byNormalizedKey } = await loadIndex();
  return byNormalizedKey.get(normalize(name)) ?? null;
}

/** Maps football-data.org's numeric team id to our slug. */
export async function teamIdFromFootballData(id: number, fallbackName: string): Promise<string> {
  const { byFootballDataId } = await loadIndex();
  const known = byFootballDataId.get(id);
  if (known) return known;

  // A team the curated file doesn't know about (promoted club nobody added yet)
  // degrades to a synthetic slug instead of dropping the match: the game keeps
  // showing up, just without a nickname.
  const slug = normalize(fallbackName).replace(/\s+/g, "-");
  console.warn(`teams.ts: unknown footballDataId ${id} ("${fallbackName}") — using synthetic slug "${slug}"`);
  return slug;
}

/** Teams whose name or alias appears in the text. Used to tag RSS passages. */
export async function tagTeams(text: string): Promise<string[]> {
  const { records } = await loadIndex();
  const normalizedText = normalize(text);
  const matches = new Set<string>();

  for (const record of records) {
    const candidates = [record.name, ...record.aliases];
    const matched = candidates.some((candidate) => {
      const pattern = new RegExp(`\\b${escapeRegExp(normalize(candidate))}\\b`);
      return pattern.test(normalizedText);
    });
    if (matched) matches.add(record.id);
  }

  return [...matches];
}
