import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  type TenantSettings,
  type UpdateTenantInput,
  updateTenantSchema,
} from '@supportpilot/shared';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TenantService } from './tenant.service';

/** Company settings: name, widget branding, allowed domains, widget key. Admins and owners. */
@Controller('tenant')
@Roles('admin')
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  get(@Auth() auth: AuthContext): Promise<TenantSettings> {
    return this.tenants.get(auth.tenantId);
  }

  @Patch()
  update(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateTenantSchema)) body: UpdateTenantInput,
  ): Promise<TenantSettings> {
    return this.tenants.update(auth.tenantId, body);
  }

  @Post('public-key/rotate')
  @HttpCode(HttpStatus.OK)
  rotate(@Auth() auth: AuthContext): Promise<TenantSettings> {
    return this.tenants.rotatePublicKey(auth.tenantId);
  }
}
