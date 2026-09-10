/**
 * Minimal local mirror of the artifact runtime contracts this app uses (claude.d.ts, db.d.ts,
 * sample.d.ts, downloads.d.ts). Only the members we call are typed; everything else is deliberately
 * left out — the contract says never to read other members of `window.claude`.
 */

export interface DbError {
  code: string;
  message: string;
}

export interface SnapshotMetadata {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export interface DocumentSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  metadata: SnapshotMetadata;
}

export interface DocumentChange {
  type: 'added' | 'modified' | 'removed';
  doc: DocumentSnapshot;
  oldIndex: number;
  newIndex: number;
}

export interface QuerySnapshot {
  docs: DocumentSnapshot[];
  size: number;
  empty: boolean;
  docChanges(): DocumentChange[];
  metadata: SnapshotMetadata;
}

export type Unsubscribe = () => void;

export interface DocumentReference {
  id: string;
  path: string;
  get(): Promise<DocumentSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (snap: DocumentSnapshot) => void, error?: (e: DbError) => void): Unsubscribe;
}

export interface CollectionReference {
  path: string;
  doc(id?: string): DocumentReference;
  get(): Promise<QuerySnapshot>;
  onSnapshot(next: (snap: QuerySnapshot) => void, error?: (e: DbError) => void): Unsubscribe;
}

export interface DB {
  doc(path: string): DocumentReference;
  collection(path: string): CollectionReference;
}

// ---- sample ----

export interface SampleMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SampleTextUpdate {
  text: string;
  delta: string;
}

export interface SampleToolInputSchema {
  type: 'object';
  properties?: { [name: string]: unknown };
  required?: string[];
  [keyword: string]: unknown;
}

export interface SampleTool {
  name: string;
  description: string;
  inputSchema?: SampleToolInputSchema;
  execute(input: { [name: string]: unknown }, context: { signal: AbortSignal }): unknown;
}

export interface SampleOptions {
  onText?: (update: SampleTextUpdate) => void;
  signal?: AbortSignal;
  modelTier?: 'default' | 'complex' | 'quick';
  cache?: boolean | { gcTime?: number; refresh?: boolean };
  tools?: SampleTool[];
}

export interface SampleResult {
  text: string;
  truncated: boolean;
  modelTierApplied: 'default' | 'complex' | 'quick';
}

export interface SampleLimits {
  maxPromptBytes: number;
  images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] };
  tools?: { maxCount: number };
}

export interface SampleError {
  code: string;
  message: string;
  text?: string;
}

export interface Sample {
  (input: string | SampleMessage[], options?: SampleOptions): Promise<SampleResult>;
  limits(): Promise<SampleLimits>;
}

// ---- downloads ----

export interface Downloads {
  save(request: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<{ status: 'saved' | 'delivered' }>;
}

export interface CapabilityMap {
  db: DB;
  sample: Sample;
  downloads: Downloads;
}
