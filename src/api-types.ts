import type * as tables from './schema.js';
export type JsonValue<T> = T extends Date
  ? string
  : T extends (infer V)[]
    ? JsonValue<V>[]
    : T extends object
      ? { [K in keyof T]: JsonValue<T[K]> }
      : T;
export type Project = JsonValue<typeof tables.projects.$inferSelect>;
export type UploadedDocument = Omit<JsonValue<typeof tables.documents.$inferSelect>, 'storageKey'>;
export type ReviewRun = Omit<
  JsonValue<typeof tables.reviews.$inferSelect>,
  'inputSnapshot' | 'resultSnapshot'
>;
export type Finding = JsonValue<typeof tables.findings.$inferSelect> & {
  evidence: JsonValue<typeof tables.evidence.$inferSelect>[];
};
export type Collection<T> = { data: T[]; limit: number; offset: number };
export type ApiError = {
  error: {
    code: string;
    message: string;
    requestId?: string;
    fields?: { path: string; message: string }[];
  };
};
export type { ProjectInput, ReviewReport, ReviewStage } from './contracts.js';
