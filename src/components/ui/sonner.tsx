'use client';

import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-white group-[.toaster]:text-slate-900 group-[.toaster]:border-slate-200 group-[.toaster]:shadow-xl group-[.toaster]:rounded-2xl',
          description: 'group-[.toast]:text-slate-500',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-white group-[.toast]:rounded-xl',
          cancelButton:
            'group-[.toast]:bg-slate-100 group-[.toast]:text-slate-700 group-[.toast]:rounded-xl',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
