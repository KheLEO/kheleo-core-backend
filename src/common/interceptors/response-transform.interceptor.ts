import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { FastifyReply } from 'fastify';

export interface StandardApiResponse<T> {
  readonly success: boolean;
  readonly data: T;
  readonly timestamp: string;
}

@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<
  T,
  StandardApiResponse<T> | T
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<StandardApiResponse<T> | T> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    return next.handle().pipe(
      map((data: T) => {
        // If 204 No Content or null/undefined, or already transformed, return as is
        if (response.statusCode === 204 || data === null || data === undefined) {
          return data;
        }

        // If data is already an object containing success/status or RFC 7807 problem details, return directly
        if (
          typeof data === 'object' &&
          ('type' in (data as Record<string, unknown>) ||
            'success' in (data as Record<string, unknown>))
        ) {
          return data;
        }

        return {
          success: true,
          data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
