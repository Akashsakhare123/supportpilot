import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { redactPii } from '@supportpilot/shared';

/** Mask emails, phone numbers and card numbers in anything that is logged (strings, errors, objects). */
export function redactForLog(value: unknown): unknown {
  if (typeof value === 'string') return redactPii(value).text;
  if (value instanceof Error) {
    const copy = new Error(redactPii(value.message).text);
    copy.name = value.name;
    copy.stack = value.stack ? redactPii(value.stack).text : undefined;
    return copy;
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(redactPii(JSON.stringify(value)).text) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * The API's logger (T15): Nest's console logger with PII masked before anything is written, so
 * customer emails, phone numbers and card numbers never end up in log files or log services.
 */
export class RedactingLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    super.printMessages(
      messages.map(redactForLog),
      context === undefined ? undefined : redactPii(context).text,
      logLevel,
      writeStreamType,
      typeof errorStack === 'string' ? redactPii(errorStack).text : errorStack,
    );
  }

  protected override printStackTrace(stack: string): void {
    super.printStackTrace(stack ? redactPii(stack).text : stack);
  }
}
