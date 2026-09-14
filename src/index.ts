import "dotenv/config";
import { loadEnv } from "./config/env.ts";

loadEnv();

console.log("Futebol RAG pronto.");
console.log("");
console.log("1) suba o Qdrant:     docker compose up -d");
console.log("2) indexe as fontes:  npm run index");
console.log('3) faça uma pergunta: npm run ask -- "o Palmeiras está numa fase ruim?"');
console.log("");
console.log("Detalhes no README.md e em docs/architecture.md.");
