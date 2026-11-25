export interface WebhookSignature {
  algorithm: 'sha256' | 'sha512';
  secret: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface WebhookMessage {
  id: string;
  timestamp: number;
  event: string;
  data: unknown;
  signature: WebhookSignature;
}

export interface WebhookVerificationConfig {
  replayWindowSeconds: number;
  algorithmPreference: 'sha256' | 'sha512';
  nonceDeduplication: boolean;
  maxClockSkew: number;
}

export interface ReplayProtectionRecord {
  nonce: string;
  timestamp: number;
  eventId: string;
  verified: boolean;
  fingerprint?: string;
}

/** Atomic nonce claims are required for shared or durable replay protection. */
export interface ReplayProtectionStore {
  get(nonce: string): ReplayProtectionRecord | undefined;
  claim(record: ReplayProtectionRecord): boolean;
  removeExpired(cutoffTimestamp: number): number;
  trim(maxRecords: number): number;
  clear(): void;
  readonly size: number;
}

export interface WebhookVerifierOptions {
  readonly replayStore?: ReplayProtectionStore;
}

export interface WebhookSubscriber {
  id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: Date;
  lastDelivery?: Date;
  failureCount: number;
  successCount: number;
}

export interface WebhookDeliveryAttempt {
  id: string;
  subscriberId: string;
  messageId: string;
  timestamp: Date;
  statusCode?: number;
  error?: string;
  retryCount: number;
  success: boolean;
}

export type ReplayWindowErrorCode =
  | 'malformed_message'
  | 'clock_skew_future'
  | 'replay_window_expired'
  | 'replay_attack_detected'
  | 'signature_verification_failed'
  | 'unauthorized_subscriber'
  | 'inactive_subscriber'
  | 'unauthorized_event'
  | 'replay_store_unavailable';

export interface ReplayWindowOptions {
  now?: number;
  subscriberId?: string;
  expectedEvent?: string;
  allowIdempotentRetry?: boolean;
}

export interface ReplayWindowVerificationResult {
  valid: boolean;
  code?: ReplayWindowErrorCode;
  error?: string;
  ageSeconds?: number;
  deliveryAttempt?: number;
  /** True when a previously verified identical delivery was safely recognized. */
  replayed?: boolean;
}
