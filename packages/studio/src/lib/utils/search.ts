// Fuzzy search utility for Zveltio

export interface Collection {
  name: string;
  label?: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
}

export interface SearchResult {
  id: string;
  name: string;
  type: 'collection' | 'user';
  score: number;
}

/**
 * Simple fuzzy search algorithm
 * @param query - The search query
 * @param text - The text to search in
 * @returns Match score (0-1)
 */
export function fuzzyMatch(query: string, text: string): number {
  if (!query || !text) return 0;

  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  // Exact match
  if (lowerText === lowerQuery) return 1;

  // Starts with match
  if (lowerText.startsWith(lowerQuery)) return 0.9;

  // Contains match
  if (lowerText.includes(lowerQuery)) return 0.7;

  // Character-by-character match (fuzzy)
  let queryIndex = 0;
  let matchScore = 0;

  for (let i = 0; i < lowerText.length; i++) {
    if (
      queryIndex < lowerQuery.length &&
      lowerText[i] === lowerQuery[queryIndex]
    ) {
      matchScore += 0.1;
      queryIndex++;
    }
  }

  // Normalize score
  return Math.min(matchScore, 0.5);
}

/**
 * Search collections
 * @param query - Search query
 * @param collections - List of collections
 * @returns Matching collections with scores
 */
export function searchCollections(
  query: string,
  collections: Collection[],
): SearchResult[] {
  if (!query || query.length < 2) return [];

  return collections
    .map((col) => {
      const nameScore = fuzzyMatch(query, col.name);
      const labelScore = col.label ? fuzzyMatch(query, col.label) : 0;
      const score = Math.max(nameScore, labelScore);

      return {
        id: col.name,
        name: col.label || col.name,
        type: 'collection' as const,
        score,
      };
    })
    .filter((item) => item.score > 0.3)
    .sort((a, b) => b.score - a.score);
}

/**
 * Search users
 * @param query - Search query
 * @param users - List of users
 * @returns Matching users with scores
 */
export function searchUsers(query: string, users: User[]): SearchResult[] {
  if (!query || query.length < 2) return [];

  return users
    .map((user) => {
      const emailScore = fuzzyMatch(query, user.email);
      const nameScore = user.name ? fuzzyMatch(query, user.name) : 0;
      const score = Math.max(emailScore, nameScore);

      return {
        id: user.id,
        name: user.name || user.email,
        type: 'user' as const,
        score,
      };
    })
    .filter((item) => item.score > 0.3)
    .sort((a, b) => b.score - a.score);
}

/**
 * Global search across all resources
 * @param query - Search query
 * @param datasets - Collections of data to search
 * @returns Matching results sorted by score
 */
export function globalSearch(
  query: string,
  datasets: { collections?: Collection[]; users?: User[] },
): SearchResult[] {
  const results: SearchResult[] = [];

  if (datasets.collections) {
    results.push(...searchCollections(query, datasets.collections));
  }

  if (datasets.users) {
    results.push(...searchUsers(query, datasets.users));
  }

  // Sort by relevance
  return results.sort((a, b) => b.score - a.score);
}
