import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Database, eq, type Tenant, tenants } from '@supportpilot/db';
import { resolveBranding, type TenantSettings, type UpdateTenantInput } from '@supportpilot/shared';
import { generatePublicKey } from '../common/tokens';
import { DRIZZLE } from '../database/database.module';

export function toTenantSettings(tenant: Tenant): TenantSettings {
  return {
    id: tenant.id,
    name: tenant.name,
    plan: tenant.plan,
    publicKey: tenant.publicKey,
    branding: resolveBranding(tenant.branding),
    allowedDomains: tenant.allowedDomains,
    handoffThreshold: tenant.handoffThreshold,
    onboardingCompleted: tenant.onboardingCompletedAt !== null,
  };
}

/** Settings of the caller's own tenant. The tenant id always comes from the access token. */
@Injectable()
export class TenantService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async get(tenantId: string): Promise<TenantSettings> {
    return toTenantSettings(await this.find(tenantId));
  }

  async update(tenantId: string, input: UpdateTenantInput): Promise<TenantSettings> {
    const current = await this.find(tenantId);
    const [updated] = await this.db
      .update(tenants)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.branding !== undefined ? { branding: input.branding } : {}),
        ...(input.allowedDomains !== undefined ? { allowedDomains: input.allowedDomains } : {}),
        ...(input.onboardingCompleted && !current.onboardingCompletedAt
          ? { onboardingCompletedAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId))
      .returning();
    return toTenantSettings(updated!);
  }

  /** New widget key; the old one stops working immediately. */
  async rotatePublicKey(tenantId: string): Promise<TenantSettings> {
    await this.find(tenantId);
    const [updated] = await this.db
      .update(tenants)
      .set({ publicKey: generatePublicKey(), updatedAt: new Date() })
      .where(eq(tenants.id, tenantId))
      .returning();
    return toTenantSettings(updated!);
  }

  private async find(tenantId: string): Promise<Tenant> {
    const tenant = await this.db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }
}
