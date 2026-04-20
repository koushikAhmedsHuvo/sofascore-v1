/**
 * Outbound HTTP client for the configured data provider (e.g. sportsdata365).
 * Retries, timeouts, and base URL/header construction are centralized here so
 * cost and reliability policies stay in one place.
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import axiosRetry from "axios-retry";
import { normalizePath } from "../../shared/utils/path.utils";
import { SofaContractService } from "../contract/sofa-contract.service";
import { AlertService } from "./alert.service";

@Injectable()
export class ProviderClientService {
  private readonly logger = new Logger(ProviderClientService.name);
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly sofaContract: SofaContractService,
    private readonly alertService: AlertService,
  ) {
    this.timeoutMs =
      this.configService.get<number>("provider.timeoutMs") ?? 15000;
    this.maxAttempts = Math.max(
      1,
      this.configService.get<number>("provider.retryAttempts") ?? 5,
    );
    const retryCount = this.maxAttempts - 1;

    axiosRetry(this.httpService.axiosRef, {
      retries: retryCount,
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
    const baseUrl = this.sofaContract.getProviderBaseUrl().replace(/\/+$/, "");
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
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      const msg = `✗ Provider error after ${elapsed}ms for ${normalizedPath}: HTTP ${status ?? "N/A"} — ${(error as Error).message}`;
      const retryCount =
        (error as { config?: { "axios-retry"?: { retryCount?: number } } })
          .config?.["axios-retry"]?.retryCount ?? 0;
      const totalAttempts = retryCount + 1;

      // Alert when all configured retries were exhausted (network/5xx errors that were retried)
      // OR when the error was non-retryable (4xx) but the provider still returned no usable data.
      // Both cases mean the provider call completely failed.
      const retriesExhausted = totalAttempts >= this.maxAttempts;
      const nonRetryableFailure =
        retryCount === 0 && status !== undefined && status >= 400;

      if (retriesExhausted || nonRetryableFailure) {
        this.logger.warn(
          `Alert condition met — retriesExhausted=${retriesExhausted} nonRetryable=${nonRetryableFailure} ` +
            `totalAttempts=${totalAttempts} maxAttempts=${this.maxAttempts} status=${status ?? "N/A"}`,
        );
        this.alertService.sendMaxRetryAlert({
          endpointUrl: url,
          totalAttempts,
          finalErrorMessage: (error as Error).message,
          timestampIso: new Date().toISOString(),
        });
      } else {
        this.logger.warn(
          `Alert NOT sent — totalAttempts=${totalAttempts} < maxAttempts=${this.maxAttempts}, ` +
            `retryCount=${retryCount}, status=${status ?? "N/A"} (retryable error, retries still in progress or config mismatch)`,
        );
      }

      if (status !== undefined && status >= 400 && status < 500) {
        this.logger.warn(msg + " (check provider API key / quota in env)");
      } else {
        this.logger.error(msg);
      }

      throw new ServiceUnavailableException({
        message: "Provider unavailable",
        path: normalizedPath,
        providerStatus: status,
      });
    }
  }
}
