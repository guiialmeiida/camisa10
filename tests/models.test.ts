import { describe, expect, it } from "vitest";
import { EMBEDDING } from "../src/config/models.ts";
import type { ModelConfig } from "../src/config/models.ts";

// These three cases used to be runtime assertions; the type now guarantees them.
// A @ts-expect-error that stops erroring is itself an error — which is exactly why
// this form works as a test, instead of "trust the compiler and delete the case".
describe("ModelConfig", () => {
  it("keeps effort out of reach for claude-haiku-4-5, dated model ids uncompilable, and dimensions literal", () => {
    // @ts-expect-error Haiku 4.5 rejects effort — the type has to keep forbidding it
    const bad1: ModelConfig = { model: "claude-haiku-4-5", maxTokens: 512, effort: "high" };
    // @ts-expect-error a model id with a date suffix must not compile
    const bad2: ModelConfig = { model: "claude-opus-5-20260401", effort: "high", maxTokens: 10 };
    const dims: 1024 = EMBEDDING.dimensions;

    void bad1;
    void bad2;
    expect(dims).toBe(1024);
  });
});
