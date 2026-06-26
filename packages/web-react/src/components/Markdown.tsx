import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { SignedImg } from "./chat/media";
import { CodeBlock } from "./CodeBlock";

export const Markdown = memo(function Markdown({
  children,
  signMedia,
}: {
  children: string;
  /** 富文本里的行内 <img>（含容器路径）经 /api/media-sign 主动签名后渲染（assistant/
   *  tool 正文用）。缺省 false 保持原生 img 行为（demo / 无媒体场景零改动）。 */
  signMedia?: boolean;
}) {
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
});
