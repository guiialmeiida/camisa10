import { embed } from "../ingestion/embed.ts";
import { search } from "../vectorstore/qdrant.ts";
import type { QdrantFilter } from "../vectorstore/qdrant.ts";
import type { SearchResult } from "../vectorstore/types.ts";

export interface SearchContextParams {
  query: string;
  k?: number | undefined;
  filter?: QdrantFilter | undefined;
}

/**
 * Embeds the query and searches the vector store. `filter` is the rigid filter built by
 * task 04 (current_matchweek's publishedAt window + team clause) — still no reranking and
 * no metadata weight or time decay, which belong to the `similarity x weight x timeDecay`
 * formula of task 05.
 */
export async function searchContext(params: SearchContextParams): Promise<SearchResult[]> {
  const vector = await embed(params.query, "query");
  return search({
    vector,
    ...(params.k !== undefined ? { k: params.k } : {}),
    ...(params.filter !== undefined ? { filter: params.filter } : {}),
  });
}
