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
