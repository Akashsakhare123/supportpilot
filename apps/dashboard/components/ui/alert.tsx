import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Alert({
  className,
  tone = 'error',
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: 'error' | 'success' | 'info' }) {
  const tones = {
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-slate-200 bg-slate-50 text-slate-700',
  };
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-md border px-3 py-2 text-sm', tones[tone], className)}
      {...props}
    />
  );
}
