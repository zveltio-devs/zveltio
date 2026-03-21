// Thin fetch wrapper — no meilisearch SDK
export class MeiliSearchClient {
  constructor(
    private host: string,
    private apiKey: string,
  ) {}

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.host}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`MeiliSearch error ${res.status}: ${errText}`);
    }

    if (res.status === 204) return null;
    return res.json();
  }

  async search(index: string, query: string, opts?: Record<string, unknown>): Promise<any> {
    return this.request(`/indexes/${encodeURIComponent(index)}/search`, {
      method: 'POST',
      body: JSON.stringify({ q: query, ...opts }),
    });
  }

  async addDocuments(index: string, docs: any[]): Promise<any> {
    return this.request(`/indexes/${encodeURIComponent(index)}/documents`, {
      method: 'POST',
      body: JSON.stringify(docs),
    });
  }

  async deleteDocument(index: string, id: string): Promise<any> {
    return this.request(`/indexes/${encodeURIComponent(index)}/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async createIndex(index: string, opts?: { primaryKey?: string }): Promise<any> {
    return this.request('/indexes', {
      method: 'POST',
      body: JSON.stringify({ uid: index, primaryKey: opts?.primaryKey ?? 'id' }),
    });
  }

  async updateSettings(index: string, settings: Record<string, unknown>): Promise<any> {
    return this.request(`/indexes/${encodeURIComponent(index)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  }
}
