import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { loadEnv } from "../config/env.ts";
import type { Effort, ModelConfig } from "../config/models.ts";

export interface StructuredCall<S extends z.ZodType> {
  config: ModelConfig;
  system: string;
  user: string;
  schema: S;
  schemaName: string;
}

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (client) return client;
  // The SDK's defaults (10 min timeout, 2 retries) can let one slow request block for
  // a very long time and burn real API spend without ever surfacing as a fast, clear
  // failure — a bounded timeout fails loud instead.
  client = new Anthropic({ apiKey: loadEnv().ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
  return client;
}

/** effort only exists on the claude-opus-5 branch of the union — the switch below narrows it. */
function outputEffort(config: ModelConfig): { effort: Effort } | Record<string, never> {
  switch (config.model) {
    case "claude-opus-5":
      return { effort: config.effort };
    case "claude-haiku-4-5":
      return {};
  }
}

export async function callStructured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
  const anthropic = getClient();

  const response = await anthropic.messages.parse({
    model: call.config.model,
    max_tokens: call.config.maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
    output_config: {
      ...outputEffort(call.config),
      format: zodOutputFormat(call.schema),
    },
  });

  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new Error(`no parsed output for ${call.schemaName} (stop_reason: ${response.stop_reason})`);
  }

  return response.parsed_output;
}

export async function callText(call: { config: ModelConfig; system: string; user: string }): Promise<string> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: call.config.model,
    max_tokens: call.config.maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
    output_config: outputEffort(call.config),
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );

  if (!textBlock) {
    throw new Error(`no text block in response (stop_reason: ${response.stop_reason})`);
  }

  return textBlock.text;
}
