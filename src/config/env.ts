import { z } from "zod";

const schema = z.object({
  // Optional until task 01 introduces the real football API (fixtures need no token).
  API_FUTEBOL_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1, "set OPENAI_API_KEY in .env"),
  ANTHROPIC_API_KEY: z.string().min(1, "set ANTHROPIC_API_KEY in .env"),
  QDRANT_URL: z.url("QDRANT_URL must be a valid URL"),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().min(1).default("camisa10"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    console.error("Invalid or missing environment variables:");
    console.error(z.prettifyError(parsed.error));
    throw new Error("Incomplete environment configuration. See .env.example.");
  }

  return parsed.data;
}
