import { describe, it, expect, afterEach } from "vitest";
import { loadEnv } from "../src/config/env.ts";
import type { Env } from "../src/config/env.ts";

const fakeEnv = {
  FOOTBALL_DATA_TOKEN: "fake-token",
  VOYAGE_API_KEY: "voyage-fake",
  ANTHROPIC_API_KEY: "sk-ant-fake",
  QDRANT_URL: "http://localhost:6333",
};

describe("loadEnv", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("loads successfully when every required variable is present", () => {
    process.env = { ...process.env, ...fakeEnv };
    expect(() => loadEnv()).not.toThrow();
  });

  it("throws when FOOTBALL_DATA_TOKEN is missing", () => {
    process.env = { ...process.env, ...fakeEnv };
    delete process.env.FOOTBALL_DATA_TOKEN;
    expect(() => loadEnv()).toThrow();
  });

  it("loads without API_FOOTBALL_KEY, which is optional", () => {
    process.env = { ...process.env, ...fakeEnv };
    delete process.env.API_FOOTBALL_KEY;
    expect(() => loadEnv()).not.toThrow();
  });

  it("throws when a required variable is missing", () => {
    process.env = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FOOTBALL_DATA_TOKEN;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.QDRANT_URL;

    expect(() => loadEnv()).toThrow();
  });

  it("defaults QDRANT_COLLECTION to camisa10 when absent", () => {
    process.env = { ...process.env, ...fakeEnv };
    delete process.env.QDRANT_COLLECTION;

    expect(loadEnv().QDRANT_COLLECTION).toBe("camisa10");
  });
});

describe("Env type", () => {
  it("no longer has API_FUTEBOL_TOKEN — the API Futebol source was dropped in discovery", () => {
    const bad: Env = {
      FOOTBALL_DATA_TOKEN: "x",
      VOYAGE_API_KEY: "x",
      ANTHROPIC_API_KEY: "x",
      QDRANT_URL: "http://localhost:6333",
      QDRANT_COLLECTION: "camisa10",
      // @ts-expect-error API_FUTEBOL_TOKEN was removed from the schema (task 01, discovery item 1)
      API_FUTEBOL_TOKEN: "x",
    };
    void bad;
  });
});
