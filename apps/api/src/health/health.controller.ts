import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HealthReport } from '@supportpilot/shared';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { HealthService } from './health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** 200 when Postgres and Redis respond, 503 otherwise (used by the deploy smoke test). */
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.check();
    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
