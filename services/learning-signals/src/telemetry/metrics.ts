export interface IngestionMetrics {
  incrementIdempotencyConflict(tenantId: string): void;
  getIdempotencyConflictCount(tenantId: string): number;
}

export class InMemoryIngestionMetrics implements IngestionMetrics {
  private conflictCount = 0;
  private readonly conflictCountsByTenant = new Map<string, number>();

  incrementIdempotencyConflict(tenantId: string): void {
    this.conflictCount += 1;
    this.conflictCountsByTenant.set(
      tenantId,
      (this.conflictCountsByTenant.get(tenantId) ?? 0) + 1,
    );
  }

  getIdempotencyConflictCount(tenantId: string): number {
    return this.conflictCountsByTenant.get(tenantId) ?? 0;
  }

  get idempotencyConflictCount(): number {
    return this.conflictCount;
  }
}

export class RecordingIngestionMetrics extends InMemoryIngestionMetrics {}
