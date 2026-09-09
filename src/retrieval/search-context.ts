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
 * Embeds the query and searches the vector store. This task: no rigid filter and no
 * reranking — the `similarity x weight x timeDecay` formula belongs to tasks 04/05,
 * and `filter` already exists here just so they can plug in without a signature change.
 */
export async function searchContext(params: SearchContextParams): Promise<SearchResult[]> {
  const vector = await embed(params.query, "query");
  return search({
    vector,
    ...(params.k !== undefined ? { k: params.k } : {}),
    ...(params.filter !== undefined ? { filter: params.filter } : {}),
  });
}
