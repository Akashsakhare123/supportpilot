import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators';

/** GET / : a friendly pointer instead of a 404 when someone opens the API in a browser. */
@Public()
@Controller()
export class AppController {
  @Get()
  info(): { name: string; version: string; health: string; dashboard: string } {
    return {
      name: 'SupportPilot API',
      version: process.env.npm_package_version ?? '0.0.0',
      health: '/health',
      dashboard: process.env.APP_URL ?? 'http://localhost:3000',
    };
  }
}
