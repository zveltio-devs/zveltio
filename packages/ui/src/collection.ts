/** The shape of a collection and its records as `GET /api/data` answers them. */

export interface CollectionField {
  name: string;
  label?: string | null;
  type: string;
  description?: string | null;
  required?: boolean;
  readonly?: boolean;
}

export interface CollectionMeta {
  name: string;
  display_name?: string | null;
  /** Only the fields this user may read. */
  fields: CollectionField[];
}

export type CollectionRecord = Record<string, unknown> & { id: string };

export interface CollectionSort {
  key: string;
  dir: 'asc' | 'desc';
}
