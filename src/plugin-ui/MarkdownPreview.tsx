import { createElement, useMemo, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";

function renderTokens(tokens: Token[], openLink: (url: string) => void): ReactNode {
  return tokens.map((token, index) => {
    const nested =
      "tokens" in token && token.tokens
        ? renderTokens(token.tokens as Token[], openLink)
        : "text" in token
          ? String(token.text)
          : "";
    switch (token.type) {
      case "space":
        return null;
      case "heading":
        return createElement(
          `h${Math.min(6, Math.max(1, token.depth))}`,
          { key: index, className: `heading heading-${token.depth}` },
          nested,
        );
      case "paragraph":
        return <p key={index}>{nested}</p>;
      case "strong":
        return <strong key={index}>{nested}</strong>;
      case "em":
        return <em key={index}>{nested}</em>;
      case "del":
        return <del key={index}>{nested}</del>;
      case "br":
        return <br key={index} />;
      case "hr":
        return <hr key={index} />;
      case "code":
        return (
          <pre key={index}>
            <code>{token.text}</code>
          </pre>
        );
      case "codespan":
        return <code key={index}>{token.text}</code>;
      case "blockquote":
        return <blockquote key={index}>{nested}</blockquote>;
      case "link":
        return /^https?:\/\//i.test(token.href) ? (
          <button key={index} type="button" className="link" onClick={() => openLink(token.href)}>
            {nested}
          </button>
        ) : (
          <span key={index}>{nested}</span>
        );
      case "image":
        return <span key={index}>[Image: {token.text || "open in NoteFlare"}]</span>;
      case "html":
        return <code key={index}>{token.raw}</code>;
      case "list": {
        const items = token.items.map((item: Tokens.ListItem, itemIndex: number) => (
          <li key={itemIndex}>
            {item.task ? (
              <span aria-label={item.checked ? "Completed" : "Incomplete"}>{item.checked ? "☑ " : "☐ "}</span>
            ) : null}
            {renderTokens(item.tokens, openLink)}
          </li>
        ));
        return token.ordered ? (
          <ol key={index} start={token.start || 1}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={index} className="table-scroll">
            <table>
              <thead>
                <tr>
                  {token.header.map((cell: Tokens.TableCell, i: number) => (
                    <th key={i}>{renderTokens(cell.tokens, openLink)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row: Tokens.TableCell[], i: number) => (
                  <tr key={i}>
                    {row.map((cell: Tokens.TableCell, j: number) => (
                      <td key={j}>{renderTokens(cell.tokens, openLink)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return <span key={index}>{nested}</span>;
    }
  });
}

export function MarkdownPreview({ markdown, openLink }: { markdown: string; openLink: (url: string) => void }) {
  const tokens = useMemo(() => marked.lexer(markdown), [markdown]);
  return <div className="markdown">{renderTokens(tokens, openLink)}</div>;
}
