import { BadRequestException, Controller, Get, Header, Query, Res } from '@nestjs/common';
import {
  type AnalyticsExport,
  analyticsCsv,
  analyticsExports,
  type AnalyticsOverview,
  type AnalyticsQuery,
  analyticsQuerySchema,
  type AnalyticsRange,
  resolveAnalyticsRange,
} from '@supportpilot/shared';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AnalyticsService } from './analytics.service';

/** Excel opens UTF-8 CSV files correctly only with a byte-order mark. */
const BOM = String.fromCharCode(0xfeff);

function rangeOf(query: AnalyticsQuery): AnalyticsRange {
  const range = resolveAnalyticsRange(query);
  if (typeof range === 'string') throw new BadRequestException(range);
  return range;
}

/** Analytics for admins and owners (the same people who manage the knowledge base). */
@Controller('analytics')
@Roles('admin')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** KPIs, daily chart data, top questions and the unanswered-questions report. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  overview(
    @Auth() auth: AuthContext,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ): Promise<AnalyticsOverview> {
    return this.analytics.overview(auth.tenantId, rangeOf(query), { fresh: !!query.fresh });
  }

  /** One report as a CSV download: ?report=daily | questions | unanswered (same range params). */
  @Get('export')
  async export(
    @Auth() auth: AuthContext,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
    @Query('report') report: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const kind = (report ?? 'daily') as AnalyticsExport;
    if (!analyticsExports.includes(kind)) {
      throw new BadRequestException(`report must be one of: ${analyticsExports.join(', ')}`);
    }
    const range = rangeOf(query);
    const overview = await this.analytics.overview(auth.tenantId, range);
    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="supportpilot-${kind}-${range.from}-to-${range.to}.csv"`,
        'Cache-Control': 'private, no-store',
      })
      .send(BOM + analyticsCsv(overview, kind));
  }
}
