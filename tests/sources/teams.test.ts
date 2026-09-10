import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listTeams, resolveTeamId, tagTeams, teamIdFromFootballData, teamRecordSchema } from "../../src/sources/teams.ts";

const TEAMS_JSON_PATH = path.join(import.meta.dirname, "..", "..", "src", "sources", "teams.json");

async function loadRawTeams(): Promise<unknown> {
  const raw = await readFile(TEAMS_JSON_PATH, "utf-8");
  return JSON.parse(raw);
}

describe("teams.json", () => {
  it("parses against teamRecordSchema, with unique id and footballDataId", async () => {
    const raw = await loadRawTeams();
    const parsed = z.array(teamRecordSchema).safeParse(raw);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const ids = parsed.data.map((team) => team.id);
    const footballDataIds = parsed.data.map((team) => team.footballDataId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(footballDataIds).size).toBe(footballDataIds.length);
  });
});

describe("resolveTeamId", () => {
  it("matches by name and alias, case/diacritic-insensitive", async () => {
    expect(await resolveTeamId("SE Palmeiras")).toBe("palmeiras");
    expect(await resolveTeamId("palmeiras")).toBe("palmeiras");
    expect(await resolveTeamId("PALMEIRAS SP")).toBe("palmeiras");
  });

  it("returns null for a team outside the curated list", async () => {
    expect(await resolveTeamId("Real Madrid")).toBeNull();
  });

  it("never resolves by nickname alone — 'Tricolor' belongs to more than one club on purpose", async () => {
    expect(await resolveTeamId("Tricolor")).toBeNull();
  });
});

describe("listTeams", () => {
  it("returns objects with exactly id, name and nicknames — no source-mapping field leaks", async () => {
    const teams = await listTeams();

    expect(teams.length).toBeGreaterThan(0);
    for (const team of teams) {
      expect(Object.keys(team).sort()).toEqual(["id", "name", "nicknames"]);
    }
  });
});

describe("teamIdFromFootballData", () => {
  it("falls back to a synthetic slug and warns instead of throwing for an unknown id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const id = await teamIdFromFootballData(999999, "Novo Time FC");

    expect(id).toBe("novo time fc".replace(/\s+/g, "-"));
    expect(warn).toHaveBeenCalled();
  });
});

describe("tagTeams", () => {
  it("matches 'baiano' via word boundary, not a loose substring of 'Bahia'", async () => {
    const teams = await tagTeams("O baiano falou sobre o clássico");
    expect(teams).not.toContain("bahia");
  });

  it("matches a known team's name inside a sentence", async () => {
    const teams = await tagTeams("O Palmeiras venceu com facilidade");
    expect(teams).toContain("palmeiras");
  });
});

describe("teams.json loading — colliding alias", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("throws at load time when two teams share a normalized alias", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify([
          { id: "team-a", name: "Team A", nicknames: [], aliases: ["Clube"], footballDataId: 1 },
          { id: "team-b", name: "Team B", nicknames: [], aliases: ["Clube"], footballDataId: 2 },
        ]),
      ),
    }));
    vi.resetModules();

    const freshTeams = await import("../../src/sources/teams.ts");

    await expect(freshTeams.listTeams()).rejects.toThrow(/collides/);
  });
});
