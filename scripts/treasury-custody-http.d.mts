import type { CustodyRevision } from './treasury-checkpoint-store.mjs';
export const TREASURY_CUSTODY_ORIGIN: string;
export function createTreasuryHttpAuthority(options: { secret: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number }): {
  config(): Promise<Record<string, unknown>>;
  listRevisions(input: { cursor: string | null; limit: number; signal?: AbortSignal }): Promise<unknown>;
  getRevision(version: number, options: { signal?: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  putRevisionIfAbsent(version: number, payload: Uint8Array, options: { signal?: AbortSignal }): Promise<{ created: boolean }>;
};
export function configuredRemoteCheckpointStore(env?: Record<string, string | undefined>, dependencies?: { fetchImpl?: typeof fetch; requestTimeoutMs?: number }): Promise<{
  checkpointStore: { read(): Promise<CustodyRevision | null>; compareAndSwap(version: number | null, state: unknown): Promise<CustodyRevision | null>; getObservability(): Record<string, unknown> };
  initialBlock: number; config: Record<string, unknown>;
}>;
