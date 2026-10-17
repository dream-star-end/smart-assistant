import { createRoot } from 'react-dom/client'
import MarkdownImpl from '../src/components/MarkdownImpl'

// The production Markdown renderer on real assistant texts (OCV5-482); nothing is mocked.
const cases = (window as unknown as { __CASES__: Record<string, string> }).__CASES__
createRoot(document.getElementById('root')!).render(
  Object.entries(cases).map(([id, text]) => (
    <div key={id} data-case={id}>
      <MarkdownImpl>{text}</MarkdownImpl>
    </div>
  )),
)
