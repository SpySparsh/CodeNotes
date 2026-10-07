import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

const buttonVariants = {
  default: 'bg-primary text-white hover:bg-purple-700 shadow-md',
  destructive: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  outline: 'border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 shadow-sm',
  secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200',
  ghost: 'hover:bg-slate-100 text-slate-700 hover:text-slate-900',
  link: 'text-primary underline-offset-4 hover:underline p-0 h-auto',
};

const sizeVariants = {
  default: 'h-10 px-4 py-2 text-sm',
  sm: 'h-8 rounded-lg px-3 text-xs',
  lg: 'h-12 rounded-xl px-6 text-base',
  icon: 'h-9 w-9 rounded-xl',
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(
          'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
          buttonVariants[variant],
          sizeVariants[size],
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button };
