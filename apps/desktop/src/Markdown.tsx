import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { memo, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

function MarkdownLink({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState('');
  return (
    <>
      <a
        href={href}
        target={href.startsWith('#') ? undefined : '_blank'}
        rel="noreferrer noopener"
        onClick={(event) => {
          if (!isTauri() || href.startsWith('#')) return;
          event.preventDefault();
          setError('');
          void invoke('open_external', { url: href }).catch(() =>
            setError('링크를 열지 못했습니다.'),
          );
        }}
      >
        {children}
      </a>
      {error && (
        <small role="alert" className="danger-text">
          {' '}
          {error}
        </small>
      )}
    </>
  );
}

// Model output is untrusted. Never enable raw HTML or automatically fetch images.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^(https?:\/\/|mailto:|#)/i.test(url) ? url : '')}
        components={{
          a: ({ href, children }) =>
            href ? <MarkdownLink href={href}>{children}</MarkdownLink> : <span>{children}</span>,
          img: ({ src, alt }) =>
            src ? (
              <MarkdownLink href={src}>이미지: {alt || '보기'}</MarkdownLink>
            ) : (
              <span>{alt}</span>
            ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
