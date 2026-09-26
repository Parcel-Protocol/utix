export interface SessionDevice {
  id: string;
  deviceType: 'web' | 'mobile' | 'desktop' | 'tablet';
  deviceName: string;
  userAgent: string;
  lastActivity: Date;
  ipAddress: string;
  active: boolean;
}

export interface CrossDeviceSession {
  id: string;
  userId: string;
  createdAt: Date;
  devices: SessionDevice[];
  primaryDevice: string;
  state: Record<string, unknown>;
  conflicts: ConflictResolution[];
  syncToken: string;
  lastSync: Date;
}

export interface StateSync {
  deviceId: string;
  timestamp: Date;
  version: number;
  state: Record<string, unknown>;
  changes: StateChange[];
}

export interface StateChange {
  path: string;
  operation: 'set' | 'update' | 'delete';
  value?: unknown;
  oldValue?: unknown;
  timestamp: Date;
}

export interface ConflictResolution {
  id: string;
  timestamp: Date;
  field: string;
  deviceAValue: unknown;
  deviceBValue: unknown;
  resolution: unknown;
  strategy: 'last-write-wins' | 'manual' | 'device-priority' | 'merge';
  resolvedBy: string;
}

export interface SyncConflict {
  field: string;
  device1Id: string;
  device1Value: unknown;
  device2Id: string;
  device2Value: unknown;
  device1Timestamp: Date;
  device2Timestamp: Date;
}

export interface SessionConfig {
  conflictStrategy: 'last-write-wins' | 'manual' | 'device-priority';
  maxDevices: number;
  syncIntervalMs: number;
  timeoutMs: number;
  primaryDeviceStrategy: 'first-active' | 'most-recent' | 'manual';
}
