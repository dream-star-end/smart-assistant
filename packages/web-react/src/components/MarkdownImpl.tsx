/**
 * Markdown 渲染重实现（react-markdown + remark-gfm + rehype-highlight + highlight.js）。
 *
 * 本模块是首屏代码分割的「重依赖边界」：被 components/Markdown.tsx 以 React.lazy()
 * 动态加载，故 react-markdown / highlight.js / unified 生态（约 600KB）全部落在按需
 * 异步 chunk，不进首屏 bundle。新增 markdown 重渲染相关依赖请加在本文件，勿回灌到
 * 同步路径。default export 为 React.lazy 约定。
 */
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { SignedImg } from "./chat/media";
import { CodeBlock } from "./CodeBlock";
import type { MarkdownProps } from "./Markdown";

export default function MarkdownImpl({ children, signMedia }: MarkdownProps) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <>{children}</>,
          ...(signMedia ? { img: ({ node: _node, ...props }) => <SignedImg {...props} /> } : {}),
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            const isBlock = className?.includes("language-") || String(children).includes("\n");
            if (isBlock) {
              return (
                <CodeBlock language={lang}>
                  <span className={className} {...props}>
                    {children}
                  </span>
                </CodeBlock>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a: ({ children, ...props }) => (
            <a target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
