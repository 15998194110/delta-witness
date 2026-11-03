export type CustodyRevision = { schema: 'delta-treasury-revision/v1'; version: number; previous_digest: string | null; digest: string;
  state: { origin_block: number; checked_through_block: number; [key: string]: unknown } };
export function checkpointRevisionDigest(state: unknown): Promise<string>;
export function validateCustodyRevision(item: unknown, options: { originBlock: number; expectedVersion: number; previousDigest: string | null }): Promise<CustodyRevision>;
export function continuousCheckpointStore(options: Record<string, unknown>): {
  read(): Promise<CustodyRevision | null>; compareAndSwap(expectedVersion: number | null, state: unknown): Promise<CustodyRevision | null>;
  getObservability(): Record<string, unknown>;
};
