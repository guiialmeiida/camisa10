import { describe, it, expect, afterEach } from "vitest";
import { loadEnv } from "../src/config/env.ts";

const fakeEnv = {
  API_FUTEBOL_TOKEN: "fake-token",
  OPENAI_API_KEY: "sk-fake",
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

  it("loads without API_FUTEBOL_TOKEN, which is optional until task 01", () => {
    process.env = { ...process.env, ...fakeEnv };
    delete process.env.API_FUTEBOL_TOKEN;
    expect(() => loadEnv()).not.toThrow();
  });

  it("throws when a required variable is missing", () => {
    process.env = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.API_FUTEBOL_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.QDRANT_URL;

    expect(() => loadEnv()).toThrow();
  });
});
