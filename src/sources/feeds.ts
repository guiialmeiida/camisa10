export interface Feed {
  name: string; // becomes Passage.source
  url: string;
}

// Versioned in the repo, not in env: a feed isn't a secret, and the vector index's
// reproducibility depends on knowing where it came from.
export const RSS_FEEDS: Feed[] = [
  { name: "Gazeta Esportiva", url: "https://www.gazetaesportiva.com/feed/" },
  // A second feed (Brazilian clubs) is deferred — see docs/tasks/01-data-sources.md,
  // "Refinamento técnico" approval note, open point 1.
];
