import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Record/replay cache for the LLM (Anthropic) and embedding (Voyage) HTTP calls made
 * during integration tests — off by default, opt-in via LLM_CASSETTE.
 *
 * `LLM_CASSETTE=record npm run test:integration` — hits the real APIs and saves every
 * response to tests/integration/__cassettes__/llm-calls.json, keyed by request
 * (host + body). Repeated identical requests append to an ordered list instead of
 * overwriting: golden-rule.test.ts asks the same question 3 times on purpose, to check
 * the invariant across independent generations, and the cassette preserves those 3
 * distinct real answers instead of collapsing them into one.
 *
 * `LLM_CASSETTE=replay npm run test:integration` — no network calls to Anthropic/Voyage
 * at all; each request pulls the next unused entry for its key, in recording order. A
 * request with no matching entry throws instead of silently falling back to the network,
 * so a stale cassette after a prompt change fails loudly.
 *
 * Local Qdrant is untouched either way — it's free and already fast.
 */
const CACHED_HOSTS = new Set(["api.anthropic.com", "api.voyageai.com"]);
const CASSETTE_PATH = path.join(import.meta.dirname, "..", "__cassettes__", "llm-calls.json");

interface CassetteEntry {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Cassette = Record<string, CassetteEntry[]>;

function resolveMode(): "record" | "replay" | null {
  const raw = process.env["LLM_CASSETTE"];
  return raw === "record" || raw === "replay" ? raw : null;
}

async function loadCassette(): Promise<Cassette> {
  try {
    return JSON.parse(await readFile(CASSETTE_PATH, "utf-8")) as Cassette;
  } catch {
    return {};
  }
}

async function saveCassette(cassette: Cassette): Promise<void> {
  await mkdir(path.dirname(CASSETTE_PATH), { recursive: true });
  await writeFile(CASSETTE_PATH, JSON.stringify(cassette, null, 2));
}

function requestKey(url: string, body: string): string {
  return createHash("sha256").update(`${url}\n${body}`).digest("hex");
}

function installCassette(mode: "record" | "replay"): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const cassetteReady = loadCassette();
  const replayCursor = new Map<string, number>();

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;

    if (!CACHED_HOSTS.has(host)) {
      return realFetch(input, init);
    }

    const body = typeof init?.body === "string" ? init.body : "";
    const key = requestKey(url, body);
    const cassette = await cassetteReady;

    if (mode === "replay") {
      const entries = cassette[key] ?? [];
      const cursor = replayCursor.get(key) ?? 0;
      const entry = entries[cursor];
      if (!entry) {
        throw new Error(
          `LLM_CASSETTE=replay has no recorded response for this request (${host}, key ${key.slice(0, 12)}…, call #${cursor + 1}). ` +
            "The prompt or request shape probably changed. Re-record with LLM_CASSETTE=record.",
        );
      }
      replayCursor.set(key, cursor + 1);
      return new Response(entry.body, { status: entry.status, headers: entry.headers });
    }

    // record
    const response = await realFetch(input, init);
    // Only successful responses get cached — a 429/5xx (rate limit, transient outage)
    // recorded here would replay as a permanent failure forever after.
    if (response.ok) {
      const text = await response.clone().text();
      // Allowlist, not blocklist: real responses carry account-identifying headers
      // (anthropic-organization-id, anthropic-workspace-id, request-id, cf-ray, Voyage's
      // billing-status warning...) that must never end up in a cassette committed to a
      // public repo. content-type is the only one the SDKs need to parse the replayed
      // response; nothing else is used by anything that reads a cassette entry.
      const headers = Object.fromEntries(
        [...response.headers.entries()].filter(([name]) => name === "content-type"),
      );
      cassette[key] ??= [];
      cassette[key].push({ status: response.status, headers, body: text });
      await saveCassette(cassette);
    }
    return response;
  }) as typeof fetch;
}

const mode = resolveMode();
if (mode !== null) {
  installCassette(mode);
  if (mode === "replay") {
    // golden-rule.test.ts asks an LLM to generate text 3 times and checks an invariant
    // that depends on that generation — a cassette recording is, by construction, a
    // sample that happened to satisfy it (recording it took several attempts; see
    // docs/tasks/00-vertical-slice.md). Replaying it proves the code around the LLM
    // calls didn't regress; it does NOT re-prove the invariant against a fresh
    // generation. Run without LLM_CASSETTE for that.
    console.warn(
      "[llm-cassette] LLM_CASSETTE=replay reproduces previously-recorded LLM generations verbatim — " +
        "it validates code around those calls, not the model's behavior on a fresh generation. " +
        "Run without LLM_CASSETTE to re-verify the golden-rule invariant itself.",
    );
  }
}
