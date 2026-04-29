import { Controller, Get } from '@nestjs/common';

@Controller()
export class RootController {
  @Get()
  root() {
    return {
      status: 'ok',
      service: 'sofascore-nest-api',
      message: 'API is running',
      endpoints: {
        liveness: '/api/v1/health/liveness',
        readiness: '/api/v1/health/readiness',
        health: '/api/v1/health',
      },
    };
  }

  @Get('healthcheck')
  healthcheck() {
    return 'ok';
  }
}
