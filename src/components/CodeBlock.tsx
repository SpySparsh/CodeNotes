'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { prism } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CodeBlockProps {
  code: string;
  language: string;
}

export default function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group rounded-xl overflow-hidden border border-slate-200 bg-slate-50 shadow-sm my-8">
      <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200">
        <span className="text-[0.8rem] font-bold font-mono text-purple-600 uppercase tracking-widest">{language || 'text'}</span>
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-md text-slate-400 hover:text-purple-600 hover:bg-purple-50 transition-colors focus:outline-none flex items-center gap-1.5 text-xs font-semibold"
          title="Copy code"
        >
          {copied ? (
            <><Check size={14} className="text-emerald-500" /> Copied!</>
          ) : (
            <><Copy size={14} /> Copy</>
          )}
        </button>
      </div>
      <div className="text-[0.9rem] overflow-x-auto leading-relaxed">
        <SyntaxHighlighter
          language={language.toLowerCase() || 'text'}
          style={prism}
          customStyle={{
            margin: 0,
            padding: '1.25rem 1.5rem',
            background: 'transparent',
            textShadow: 'none',
          }}
          wrapLongLines={false}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
