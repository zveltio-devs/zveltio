export class TypesenseClient {
  constructor(
    private host: string,
    private port: number,
    private apiKey: string,
  ) {}

  private get baseUrl(): string {
    return `${this.host}:${this.port}`;
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'X-TYPESENSE-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Typesense error ${res.status}: ${errText}`);
    }

    if (res.status === 204) return null;
    return res.json();
  }

  async search(collection: string, query: string, opts?: Record<string, unknown>): Promise<any> {
    const params = new URLSearchParams({
      q: query,
      query_by: (opts?.query_by as string) ?? 'id',
      ...Object.fromEntries(
        Object.entries(opts ?? {}).filter(([k]) => k !== 'query_by').map(([k, v]) => [k, String(v)]),
      ),
    });
    return this.request(`/collections/${encodeURIComponent(collection)}/documents/search?${params}`, {
      method: 'GET',
    });
  }

  async upsertDocument(collection: string, doc: any): Promise<any> {
    return this.request(
      `/collections/${encodeURIComponent(collection)}/documents?action=upsert`,
      {
        method: 'POST',
        body: JSON.stringify(doc),
      },
    );
  }

  async deleteDocument(collection: string, id: string): Promise<any> {
    return this.request(
      `/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  async createCollection(schema: Record<string, unknown>): Promise<any> {
    return this.request('/collections', {
      method: 'POST',
      body: JSON.stringify(schema),
    });
  }
}
