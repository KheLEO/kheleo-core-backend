import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FastifyReply, FastifyRequest } from 'fastify';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'A database error occurred.';

    switch (exception.code) {
      case 'P2002':
        status = HttpStatus.CONFLICT;
        detail = `A record with that unique value already exists (${(exception.meta?.['target'] as string[])?.join(', ') ?? 'unknown field'}).`;
        break;
      case 'P2025':
        status = HttpStatus.NOT_FOUND;
        detail = 'The requested record was not found.';
        break;
      case 'P2003':
        status = HttpStatus.BAD_REQUEST;
        detail = 'A related record referenced by a foreign key was not found.';
        break;
      default:
        this.logger.error(`Prisma error ${exception.code}`, exception.message);
    }

    void response
      .status(status)
      .header('Content-Type', 'application/problem+json')
      .send({
        type: `https://api.kheleo.com/errors/prisma-${exception.code}`,
        title: HttpStatus[status] ?? 'Database Error',
        status,
        detail,
        instance: request.url,
        timestamp: new Date().toISOString(),
      });
  }
}
