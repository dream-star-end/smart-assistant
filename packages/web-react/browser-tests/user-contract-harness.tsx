import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ModelSelector } from '../src/components/ModelSelector'
function ContractPicker() {
  const [model, setModel] = useState('gpt-5.6-sol')
  return (
    <>
      <ModelSelector
        models={[
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', engine: 'codex' },
          { id: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', engine: 'codex' },
          { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', engine: 'ccb' },
        ]}
        selectedId={model}
        onSelect={setModel}
      />
      <output data-testid="selected-model">{model}</output>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<ContractPicker />)
