import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Database, eq, type Tenant, tenants } from '@supportpilot/db';
import {
  isOriginAllowed,
  PUBLIC_KEY_PATTERN,
  resolveBranding,
  type WidgetConfig,
} from '@supportpilot/shared';
import { DRIZZLE } from '../database/database.module';

/** Everything the widget can reach is resolved from its public key (multi-tenancy layer 1). */
@Injectable()
export class WidgetService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Tenant for a public key, enforcing the tenant's allowed domains against the Origin header. */
  async resolveTenant(publicKey: string | undefined, origin: string | undefined): Promise<Tenant> {
    if (!publicKey || !PUBLIC_KEY_PATTERN.test(publicKey)) {
      throw new BadRequestException('A valid widget key (?key=pk_...) is required');
    }
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.publicKey, publicKey),
    });
    if (!tenant) throw new NotFoundException('Unknown widget key');
    if (!isOriginAllowed(origin, tenant.allowedDomains)) {
      throw new ForbiddenException('This website is not allowed to use this widget');
    }
    return tenant;
  }

  /** Public, cacheable config. Only fields that are safe on any website. */
  async config(publicKey: string | undefined, origin: string | undefined): Promise<WidgetConfig> {
    const tenant = await this.resolveTenant(publicKey, origin);
    return { tenantName: tenant.name, branding: resolveBranding(tenant.branding) };
  }
}
