import type {StandardSchemaV1} from '@standard-schema/spec';

/** A deliberately public HTTP failure. Other errors must not expose their message to clients. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'HTTP_ERROR',
  ) {
    super(message);
    this.name = 'HttpError';
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError('HTTP error status must be between 400 and 599.');
    }
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication is required.') {
    super(401, message, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Permission denied.') {
    super(403, message, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

/** One failed request-validation rule; `pointer` is an RFC 6901 JSON Pointer into `in`. */
export interface ProblemIssue {
  readonly in: 'params' | 'query' | 'body';
  readonly pointer: string;
  readonly message: string;
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  /** Present only on 400 VALIDATION_ERROR responses whose issues could be listed. */
  readonly errors?: readonly ProblemIssue[];
}

type IssuePath = StandardSchemaV1.Issue['path'];

function jsonPointer(path: IssuePath): string {
  return (path ?? [])
    .map(segment => {
      const key = typeof segment === 'object' ? segment.key : segment;
      return `/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
    })
    .join('');
}

export function problemIssues(
  location: ProblemIssue['in'],
  issues: readonly StandardSchemaV1.Issue[],
): ProblemIssue[] {
  return issues.map(issue => ({
    in: location,
    pointer: jsonPointer(issue.path),
    message: issue.message,
  }));
}

const titles: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Internal Elysia error mapping; callers receive only safe Problem JSON. */
export function problemHandler(
  {
    error,
    code,
  }: {
    error: unknown;
    code: string | number;
  },
  issues?: readonly ProblemIssue[],
): Response {
  let status: number;
  let detail: string;
  let problemCode: string;

  if (error instanceof HttpError) {
    status = error.status;
    detail = error.message;
    problemCode = error.code;
  } else if (
    code === 'VALIDATION' &&
    !(error instanceof Error && 'type' in error && error.type === 'response')
  ) {
    status = 400;
    detail = 'Request validation failed.';
    problemCode = 'VALIDATION_ERROR';
  } else if (code === 'PARSE') {
    status = 400;
    detail = 'Request body could not be parsed.';
    problemCode = 'PARSE_ERROR';
  } else if (code === 'NOT_FOUND') {
    status = 404;
    detail = 'Resource not found.';
    problemCode = 'NOT_FOUND';
  } else {
    status = 500;
    detail = 'Internal server error.';
    problemCode = 'INTERNAL_SERVER_ERROR';
  }

  const problem: Problem = {
    type: 'about:blank',
    title: titles[status] ?? 'HTTP Error',
    status,
    detail,
    code: problemCode,
    ...(issues?.length && problemCode === 'VALIDATION_ERROR'
      ? {errors: issues}
      : {}),
  };
  return new Response(JSON.stringify(problem), {
    status,
    headers: {'content-type': 'application/problem+json'},
  });
}
