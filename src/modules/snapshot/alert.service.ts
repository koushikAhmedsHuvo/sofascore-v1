import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailerService } from "@nestjs-modules/mailer";

export interface MaxRetryAlertDetails {
  endpointUrl: string;
  totalAttempts: number;
  finalErrorMessage: string;
  timestampIso: string;
}

export interface SchemaMismatchIssue {
  field: string;
  message: string;
}

export interface SchemaMismatchAlertDetails {
  endpointUrl: string;
  issues: SchemaMismatchIssue[];
  receivedKeys: string[];
  missingKeys: string[];
  timestampIso: string;
}

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private readonly dedupeWindowMs: number;
  private readonly recentAlertMap = new Map<string, number>();

  constructor(
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {
    this.dedupeWindowMs =
      this.configService.get<number>("ALERT_DEDUP_WINDOW_MS") ?? 10 * 60 * 1000;
  }

  sendMaxRetryAlert(details: MaxRetryAlertDetails): void {
    try {
      const dedupeKey = [
        "max-retry",
        details.endpointUrl,
        details.totalAttempts.toString(),
        details.finalErrorMessage,
      ].join("|");

      if (!this.shouldSendAlert(dedupeKey)) {
        return;
      }

      const to = this.configService.get<string>("ALERT_EMAIL_TO") ?? "";
      if (!to) {
        this.logger.error(
          "[AlertService] ALERT_EMAIL_TO env var is not set — max-retry alert was triggered but cannot be sent. " +
            "Add ALERT_EMAIL_TO=your@email.com to your .env file.",
        );
        return;
      }

      void this.mailerService
        .sendMail({
          to,
          subject: "🚨 Proxy API Unreachable After 5 Retries",
          text: [
            "Proxy API call exhausted all retry attempts.",
            `Endpoint URL: ${details.endpointUrl}`,
            `Total attempts made: ${details.totalAttempts}`,
            `Final error message: ${details.finalErrorMessage}`,
            `Timestamp: ${details.timestampIso}`,
          ].join("\n"),
        })
        .then(() => {
          this.logger.warn(`Sent max-retry alert for ${details.endpointUrl}`);
        })
        .catch((err: unknown) => {
          this.logger.error(
            `Failed to send max-retry alert: ${(err as Error).message}`,
            (err as Error).stack,
          );
        });
    } catch (err) {
      this.logger.error(
        `Unexpected max-retry alert failure: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  sendSchemaMismatchAlert(details: SchemaMismatchAlertDetails): void {
    try {
      const issueSignature = details.issues
        .map((i) => `${i.field}:${i.message}`)
        .sort()
        .join(";");
      const dedupeKey = [
        "schema-mismatch",
        details.endpointUrl,
        issueSignature,
      ].join("|");

      if (!this.shouldSendAlert(dedupeKey)) {
        return;
      }

      const to = this.configService.get<string>("ALERT_EMAIL_TO") ?? "";
      if (!to) {
        this.logger.error(
          "[AlertService] ALERT_EMAIL_TO env var is not set — schema-mismatch alert was triggered but cannot be sent. " +
            "Add ALERT_EMAIL_TO=your@email.com to your .env file.",
        );
        return;
      }

      const issueLines =
        details.issues.length > 0
          ? details.issues
              .map((issue) => `- ${issue.field}: ${issue.message}`)
              .join("\n")
          : "- (no issues available)";

      void this.mailerService
        .sendMail({
          to,
          subject: "⚠️ Proxy API Response Schema Mismatch Detected",
          text: [
            "Proxy API response failed schema validation.",
            `Endpoint URL: ${details.endpointUrl}`,
            "Validation issues:",
            issueLines,
            `Received keys: ${details.receivedKeys.join(", ") || "(none)"}`,
            `Expected but missing keys: ${details.missingKeys.join(", ") || "(none)"}`,
            `Timestamp: ${details.timestampIso}`,
          ].join("\n"),
        })
        .then(() => {
          this.logger.warn(
            `Sent schema mismatch alert for ${details.endpointUrl}`,
          );
        })
        .catch((err: unknown) => {
          this.logger.error(
            `Failed to send schema mismatch alert: ${(err as Error).message}`,
            (err as Error).stack,
          );
        });
    } catch (err) {
      this.logger.error(
        `Unexpected schema-mismatch alert failure: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private shouldSendAlert(key: string): boolean {
    const now = Date.now();

    for (const [existingKey, sentAt] of this.recentAlertMap.entries()) {
      if (now - sentAt > this.dedupeWindowMs) {
        this.recentAlertMap.delete(existingKey);
      }
    }

    const existing = this.recentAlertMap.get(key);
    if (existing && now - existing <= this.dedupeWindowMs) {
      this.logger.debug(`Deduped alert key=${key}`);
      return false;
    }

    this.recentAlertMap.set(key, now);
    return true;
  }
}
