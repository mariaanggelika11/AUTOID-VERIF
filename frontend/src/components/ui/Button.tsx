import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type ButtonProps = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>;

export function Button({ className = '', children, ...props }: ButtonProps) {
  return (
    <button
      className={`rounded-md bg-[#2563EB] px-4 py-2 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
