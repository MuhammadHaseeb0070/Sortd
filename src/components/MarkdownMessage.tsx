'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownMessageProps {
  content: string;
}

export default function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="markdown-body text-[12.5px] leading-relaxed text-slate-800 break-words font-sans selection:bg-emerald-100 select-text cursor-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="mb-2 last:mb-0 leading-relaxed text-slate-700 font-normal select-text cursor-text">
              {children}
            </p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-slate-900 tracking-tight">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-slate-600 font-normal">{children}</em>
          ),
          h1: ({ children }) => (
            <h1 className="text-[14px] font-bold text-slate-900 mt-3.5 mb-1.5 first:mt-0 tracking-tight flex items-center space-x-1.5 select-text">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 inline-block shrink-0" />
              <span>{children}</span>
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[13px] font-semibold text-slate-900 mt-3 mb-1 first:mt-0 tracking-tight select-text">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[12px] font-semibold text-slate-800 mt-2 mb-1 first:mt-0 select-text">
              {children}
            </h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-outside pl-4 space-y-1 my-2 text-[12px] text-slate-700 marker:text-emerald-600 select-text">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-outside pl-4 space-y-1 my-2 text-[12px] text-slate-700 marker:text-slate-500 font-mono text-[11px] select-text">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed pl-0.5 select-text">{children}</li>
          ),
          code: ({ className, children, ...props }: any) => {
            return (
              <code
                className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-emerald-800 border border-slate-200 font-medium select-text cursor-text"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 p-2.5 rounded-md bg-slate-50 border border-slate-200 overflow-x-auto text-[11px] font-mono text-slate-800 leading-normal select-text cursor-text">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-emerald-600 bg-slate-50 rounded-r px-3 py-1.5 my-2 text-slate-700 italic text-[12px]">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2.5 overflow-x-auto rounded border border-slate-200">
              <table className="w-full text-[11px] border-collapse bg-white text-left">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-slate-100/80 text-slate-800 font-semibold border-b border-slate-200">
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th className="px-2.5 py-1.5 border-r border-slate-200 last:border-r-0 font-medium text-slate-800">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2.5 py-1.5 border-t border-slate-200 border-r border-slate-200 last:border-r-0 text-slate-700">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
