import axios from 'axios';

export function toPercent(value: number | null) {
  if (value === null) return '-';
  return `${Math.max(0, (1 - value) * 100).toFixed(1)}%`;
}

export function getErrorMessage(error: unknown) {
  if (axios.isAxiosError<{ message?: string }>(error)) {
    return error.response?.data?.message ?? error.message;
  }

  return error instanceof Error ? error.message : 'Something went wrong';
}
