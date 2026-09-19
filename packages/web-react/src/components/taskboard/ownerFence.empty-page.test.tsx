import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TooltipProvider } from '../ui'
import { TicketListView } from './TicketListView'
afterEach(cleanup)
test('filtered empty page keeps a reachable load-more action when server has more rows', () => {
 const more=vi.fn()
 render(<TooltipProvider><TicketListView tickets={[]} query={{type:'bug'}} onQueryChange={()=>{}} total={201} onLoadMore={more} hideFilters /></TooltipProvider>)
 fireEvent.click(screen.getByTestId('ticket-list-load-more'))
 expect(more).toHaveBeenCalledOnce()
})
