/**
 * Global exception filter: maps every thrown error to a consistent JSON body
 * `{ statusCode, message, error, path, timestamp }` so clients never see raw
 * stack traces in the response. Unhandled errors are logged server-side with
 * stack traces for debugging.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";

interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string | Record<string, unknown>;
  details?: Record<string, unknown>;
  path: string;
  timestamp: string;
}

/** Registered in `main.ts` via `useGlobalFilters`. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = "Internal server error";
    let error: string | Record<string, unknown> = "InternalServerError";
    let details: Record<string, unknown> | undefined;

    // Non-Error throws (string, object) fall through to 500 with generic body — rare in Nest.
    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === "string") {
        message = res;
      } else if (typeof res === "object" && res !== null) {
        const resObj = res as Record<string, unknown>;
        message = (resObj["message"] as string | string[]) ?? message;

        const resError = resObj["error"];
        if (typeof resError === "string") {
          error = resError;
        } else if (resError && typeof resError === "object") {
          error = resError as Record<string, unknown>;
        }

        const {
          statusCode: _statusCode,
          message: _message,
          error: _error,
          ...rest
        } = resObj;
        if (Object.keys(rest).length > 0) {
          details = rest;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}`,
        exception.stack,
      );
      message = exception.message;
    }

    const body: ErrorResponse = {
      statusCode,
      message,
      error,
      ...(details ? { details } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(statusCode).json(body);
  }
}
