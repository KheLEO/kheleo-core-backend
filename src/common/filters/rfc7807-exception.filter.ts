import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly invalidParams?: ReadonlyArray<{ name: string; reason: string }>;
  readonly timestamp: string;
}

@Catch()
export class Rfc7807ExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(Rfc7807ExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred.';
    let invalidParams: ProblemDetails['invalidParams'];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        title = (obj['error'] as string) ?? exception.name;

        if (Array.isArray(obj['message'])) {
          detail = 'Validation failed for one or more fields.';
          invalidParams = (obj['message'] as string[]).map((msg) => ({
            name: msg.split(' ')[0] ?? 'field',
            reason: msg,
          }));
        } else {
          detail = (obj['message'] as string) ?? exception.message;
        }
      } else {
        detail = res as string;
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    const problem: ProblemDetails = {
      type: `https://api.kheleo.com/errors/http-${status}`,
      title,
      status,
      detail,
      instance: request.url,
      invalidParams,
      timestamp: new Date().toISOString(),
    };

    void response
      .status(status)
      .header('Content-Type', 'application/problem+json')
      .send(problem);
  }
}
