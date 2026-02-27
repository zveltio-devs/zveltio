import type { ZveltioConfig, QueryOptions, QueryResponse } from '../types/index.js';

export class QueryBuilder {
  private _collection: string;
  private _config: ZveltioConfig;
  private _filters: Record<string, any> = {};
  private _options: QueryOptions = {};

  constructor(collection: string, config: ZveltioConfig) {
    this._collection = collection;
    this._config = config;
  }

  // Filtering
  where(field: string, value: any): this;
  where(field: string, op: string, value: any): this;
  where(field: string, opOrValue: any, value?: any): this {
    if (value === undefined) {
      this._filters[field] = opOrValue;
    } else {
      this._filters[field] = { [opOrValue]: value };
    }
    return this;
  }

  // Pagination
  page(n: number): this { this._options.page = n; return this; }
  limit(n: number): this { this._options.limit = n; return this; }

  // Sorting
  sortBy(field: string, order: 'asc' | 'desc' = 'asc'): this {
    this._options.sort = field;
    this._options.order = order;
    return this;
  }

  // Search
  search(q: string): this { this._options.search = q; return this; }

  // Execute
  async query<T = any>(overrideOptions?: QueryOptions): Promise<QueryResponse<T>> {
    const opts = { ...this._options, ...overrideOptions };
    const params = new URLSearchParams();

    if (opts.page) params.set('page', String(opts.page));
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.order) params.set('order', opts.order);
    if (opts.search) params.set('search', opts.search);
    if (Object.keys(this._filters).length > 0) {
      params.set('filter', JSON.stringify(this._filters));
    }

    const qs = params.toString();
    const url = `/api/data/${this._collection}${qs ? '?' + qs : ''}`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this._config.apiKey) headers['X-API-Key'] = this._config.apiKey;

    const res = await fetch(`${this._config.baseUrl}${url}`, {
      credentials: 'include',
      headers,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Query failed: ${res.status}`);
    }

    return res.json() as Promise<QueryResponse<T>>;
  }

  // Async iterable — allows `for await (const page of query)`
  async *[Symbol.asyncIterator]<T = any>(): AsyncGenerator<T[]> {
    let currentPage = this._options.page || 1;
    const pageSize = this._options.limit || 20;

    while (true) {
      const result = await this.page(currentPage).limit(pageSize).query<T>();
      if (result.records.length === 0) break;
      yield result.records;
      if (currentPage >= result.pagination.pages) break;
      currentPage++;
    }
  }
}
