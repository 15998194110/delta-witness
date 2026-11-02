export type Product = 'capture' | 'preflight';
export type PrivateExportAuthorization = {
  operation_id: string; token: string; ttl_seconds: number; expected_generation: number;
} & ({ phase: 'pending'; generation?: never; expires_at?: never } | { phase: 'confirmed'; generation: number; expires_at: string });
export type ExportAuthorizationResult = { ok: true; order_id: string; authorization: null | {
  operation_id: string; generation: number; expires_at: string; scope: ['export']; state: 'active' | 'expired';
} };
export type OrderRecord = {
  schema: 'delta-client-order/v1'; revision: number; order_id: string; origin: string;
  product: Product; request_json: string; request_digest: string; recovery_token: string;
  phase: 'prepared' | 'signing_started' | 'uncertain' | 'complete'; retention_policy_hash?: string;
  export_authorization?: PrivateExportAuthorization;
};
export type OrderStore = {
  load(id: string): Promise<unknown | null>;
  compareAndSet(id: string, expectedRevision: number | null, next: OrderRecord): Promise<boolean>;
};
export type Delivery = {
  ok: true; product: Product; proof_id: string; manifest_url: string; public_proof_url: string;
  bundle_root: string; observed_at: string; safe?: boolean | null; changed?: boolean | null;
  reason?: string; diff?: unknown; idempotent_replay?: boolean;
};
export type OrderResult = { order_id: string; product: Product; state: OrderRecord['phase']; delivery?: Delivery };
export type DeltaFetch = (url: string, init: RequestInit) => Response | Promise<Response>;
export class DeltaWitness {
  constructor(options?: { baseUrl?: string; fetchImpl?: DeltaFetch; requestTimeoutMs?: number; orderStore?: OrderStore; channel?: string });
  prepareOrder(product: Product, input: Record<string, unknown>, options?: { orderId?: string; retentionPolicyHash?: string }): Promise<OrderResult>;
  executeOrder(id: string, paidFetch: DeltaFetch): Promise<OrderResult>;
  recoverOrder(id: string): Promise<OrderResult>;
  renewExportAuthorization(id: string, options?: { ttlSeconds?: number }): Promise<ExportAuthorizationResult>;
  recoverExportAuthorization(id: string): Promise<ExportAuthorizationResult>;
  exportArtifact(id: string, artifact: 'html' | 'markdown' | 'screenshot' | 'manifest', options?: { authorization?: 'original' | 'derived' }): Promise<{
    order_id: string; artifact: string; bytes: Uint8Array; filename: string; content_sha256: string; content_type: string;
  }>;
  quote(product?: Product): Promise<unknown>;
  demo(): Promise<unknown>;
  proof(id: string): Promise<unknown>;
  paymentChallenge(url: string, options?: Record<string, unknown>): Promise<unknown>;
  preflightChallenge(input: Record<string, unknown>): Promise<unknown>;
  captureWithPaidFetch(url: string, paidFetch: typeof fetch): Promise<Delivery>;
  preflightWithPaidFetch(input: Record<string, unknown>, paidFetch: typeof fetch): Promise<Delivery>;
}
export default DeltaWitness;
