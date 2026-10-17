import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import type { WidgetConfig } from '@supportpilot/shared';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { WidgetService } from './widget.service';

/** Endpoints called by widget.js on client websites (CORS open, no cookies, key-based). */
@Public()
@Controller('widget')
export class WidgetController {
  constructor(private readonly widget: WidgetService) {}

  @Get('config')
  async config(
    @Query('key') key: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WidgetConfig> {
    const config = await this.widget.config(key, origin);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Vary', 'Origin');
    return config;
  }
}
