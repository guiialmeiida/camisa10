import "dotenv/config";
import { loadEnv } from "./config/env.ts";

const env = loadEnv();

console.log("Futebol RAG - initial setup ok.");
console.log(`Environment loaded (${Object.keys(env).length} required variables checked).`);
console.log("Next step: docs/tasks/00-vertical-slice.md");
