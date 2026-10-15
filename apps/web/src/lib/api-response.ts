import { NextResponse } from 'next/server';

interface ApiSuccessResponse<T> {
  ok: true;
  data: T;
}

interface ApiErrorResponse {
  ok: false;
  error: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export function apiSuccess<T>(data: T, status = 200): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ ok: true, data }, { status });
}

export function apiError(error: string, status = 400): NextResponse<ApiResponse<never>> {
  return NextResponse.json({ ok: false, error }, { status });
}
