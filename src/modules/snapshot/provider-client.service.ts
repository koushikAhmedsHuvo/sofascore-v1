/**
 * Outbound HTTP client for the configured data provider (e.g. sportsdata365).
 * Retries, timeouts, and base URL/header construction are centralized here so
 * cost and reliability policies stay in one place.
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import axiosRetry from 'axios-retry';
import { normalizePath } from '../../shared/utils/path.utils';
import { SofaContractService } from '../contract/sofa-contract.service';

@Injectable()
export class ProviderClientService {
  private readonly logger = new Logger(ProviderClientService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly sofaContract: SofaContractService,
  ) {
    this.timeoutMs =
      this.configService.get<number>('provider.timeoutMs') ?? 15000;

    axiosRetry(this.httpService.axiosRef, {
      retries: this.configService.get<number>('provider.retryAttempts') ?? 3,
      retryDelay: axiosRetry.exponentialDelay,
      /** Do not retry most 4xx (quota/auth) — **403** is explicitly excluded alongside 5xx backoff. */
      retryCondition: (error) => {
        const status = error.response?.status;
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          (!!status && status >= 500 && status !== 403)
        );
      },
      onRetry: (retryCount, error, requestConfig) => {
        this.logger.warn(
          `Provider retry #${retryCount} for ${requestConfig.url} — reason: ${error.message}`,
        );
      },
    });
  }

  /**
   * GET `{providerBaseUrl}/{normalizedPath}` with contract headers and query `params`.
   * On failure wraps axios errors as {@link ServiceUnavailableException} for API consistency.
   */
  async fetch<T = Record<string, unknown>>(
    sofaPath: string,
    params?: Record<string, string>,
  ): Promise<{ data: T; status: number }> {
    const normalizedPath = normalizePath(sofaPath);
    const baseUrl = this.sofaContract.getProviderBaseUrl().replace(/\/+$/, '');
    /** Single slash join — base URL must not end with `/`, path must not start with `/` after normalize. */
    const url = `${baseUrl}/${normalizedPath}`;

    this.logger.debug(`→ Provider fetch: GET ${url}`);

    const startTime = Date.now();

    try {
      const response = await firstValueFrom(
        this.httpService.get<T>(url, {
          timeout: this.timeoutMs,
          params,
          headers: this.sofaContract.buildProviderHeaders(),
        }),
      );

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `← Provider ${response.status} in ${elapsed}ms: ${normalizedPath}`,
      );

      return { data: response.data, status: response.status };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const status = (error as { response?: { status?: number } })?.response?.status;
      const msg = `✗ Provider error after ${elapsed}ms for ${normalizedPath}: HTTP ${status ?? 'N/A'} — ${(error as Error).message}`;
      if (status !== undefined && status >= 400 && status < 500) {
        this.logger.warn(msg + ' (check provider API key / quota in env)');
      } else {
        this.logger.error(msg);
      }

      throw new ServiceUnavailableException({
        message: 'Provider unavailable',
        path: normalizedPath,
        providerStatus: status,
      });
    }
  }
}
