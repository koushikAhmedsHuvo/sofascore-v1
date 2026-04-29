import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SofaContractService } from './modules/contract/sofa-contract.service';

@Controller()
export class RootController {
  constructor(
    private readonly configService: ConfigService,
    private readonly sofaContract: SofaContractService,
  ) {}

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

  @Get('provider-debug')
  providerDebug() {
    const authHeaderName =
      this.configService.get<string>('provider.authHeaderName') ?? 'x-api-key';
    const apiKey = this.configService.get<string>('provider.apiKey') ?? '';
    const outgoingHeaders = this.sofaContract.buildProviderHeaders();

    return {
      status: 'ok',
      providerBaseUrl: this.sofaContract.getProviderBaseUrl(),
      authHeaderName,
      apiKeyConfigured: apiKey.length > 0,
      apiKeyPreview: this.maskSecret(apiKey),
      authHeaderWillBeSent: authHeaderName in outgoingHeaders,
      outgoingHeaderNames: Object.keys(outgoingHeaders).sort(),
      authHeaderPreview: authHeaderName in outgoingHeaders ? 'present' : 'absent',
      referer: outgoingHeaders.Referer ?? null,
      origin: outgoingHeaders.Origin ?? null,
      userAgentPreview: this.truncate(outgoingHeaders['User-Agent'] ?? '', 80),
      note: 'Temporary debug endpoint. Remove after Render provider config is verified.',
    };
  }

  private maskSecret(value: string): string | null {
    if (!value) return null;
    if (value.length <= 8) return '*'.repeat(value.length);
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}...`;
  }
}
