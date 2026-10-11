import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';

@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      map((data: unknown) => {
        const http = context.switchToHttp();
        const response = http.getResponse<FastifyReply>();
        const request = http.getRequest<{ method: string; headers: Record<string, string> }>();

        if (request.method !== 'GET') {
          return data;
        }

        const bodyStr = JSON.stringify(data);
        const hash = crypto.createHash('md5').update(bodyStr).digest('hex');
        const etag = `"${hash}"`;

        void response.header('ETag', etag);

        const ifNoneMatch = request.headers['if-none-match'];
        if (ifNoneMatch === etag) {
          void response.status(304);
          return null;
        }

        return data;
      }),
    );
  }
}
