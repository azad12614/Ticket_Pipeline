import type { Request, Response, NextFunction } from 'express';

interface AppError {
  code: number;
  error: string;
  message: string;
}

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'error' in err &&
    'message' in err
  );
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (isAppError(err)) {
    res.status(err.code).json({ error: err.error, message: err.message, code: err.code });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: 'INTERNAL_ERROR', message, code: 500 });
}
