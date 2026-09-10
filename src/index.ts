import "dotenv/config";
import { loadEnv } from "./config/env.ts";

loadEnv();

console.log("Futebol RAG - vertical slice pronta.");
console.log("");
console.log("1) suba o Qdrant:     docker compose up -d");
console.log("2) indexe o fixture:  npm run index");
console.log('3) faça uma pergunta: npm run ask -- "o Palmeiras está numa fase ruim?"');
console.log("");
console.log("Detalhes em docs/tasks/00-vertical-slice.md.");
