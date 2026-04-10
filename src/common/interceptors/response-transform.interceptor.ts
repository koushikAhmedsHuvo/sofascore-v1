/**
 * Wraps successful JSON responses in `{ data, meta }` for non-proxy routes.
 * Register globally with `APP_INTERCEPTOR` if you want this envelope; until then
 * controllers return raw objects. Proxy handlers should set `req.sofaRawResponse`
 * to skip wrapping when this interceptor is enabled, preserving the SofaScore JSON contract.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  data: T;
  meta: {
    timestamp: string;
    source: 'cache' | 'database' | 'provider';
    cached?: boolean;
  };
}

/**
 * Wraps non-SofaScore proxy responses in a standard envelope.
 * SofaScore proxy routes bypass this interceptor and return raw payloads
 * directly to maintain consumer compatibility.
 */
@Injectable()
export class ResponseTransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T> | T>
{
  /**
   * If `req.sofaRawResponse` is set (Sofa proxy), returns the handler body unchanged.
   * Otherwise wraps `{ data, meta }`. **`meta.source` is a placeholder** (`database`) —
   * it does not reflect cache vs DB; fix before enabling globally if clients rely on it.
   */
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | T> {
    return next.handle().pipe(
      map((data) => {
        const request = context.switchToHttp().getRequest<{
          url: string;
          sofaRawResponse?: boolean;
        }>();
        if (request.sofaRawResponse) return data;

        return {
          data,
          meta: {
            timestamp: new Date().toISOString(),
            source: 'database',
          },
        } as ApiResponse<T>;
      }),
    );
  }
}
