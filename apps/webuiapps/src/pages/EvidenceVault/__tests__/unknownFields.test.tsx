import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// An agent can write any string into type/category/impact; the validators let it
// through. One such file used to throw during render and take the desktop down.
const AGENT_WRITTEN_FILE = {
  id: 'e1',
  title: 'Shredded ledger',
  description: 'Recovered from the office bin.',
  content: 'Columns of numbers.',
  type: 'spreadsheet',
  category: 'financial',
  impact: 'catastrophic',
  source: 'Office',
  timestamp: 1,
  credibility: 3,
  importance: 4,
  tags: [],
};

vi.mock('@/lib', () => ({
  useFileSystem: () => ({
    initFromCloud: async () => {},
    getChildrenByPath: () => [{ type: 'file', content: JSON.stringify(AGENT_WRITTEN_FILE) }],
  }),
  useAgentActionListener: () => {},
  reportAction: vi.fn(),
  reportLifecycle: vi.fn(),
  createAppFileApi: () => ({}),
  fetchVibeInfo: async () => ({}),
}));

import EvidenceVault from '../index';

afterEach(cleanup);

describe('EvidenceVault with values outside its maps', () => {
  it('renders the card and the detail view with fallbacks', async () => {
    render(<EvidenceVault />);

    fireEvent.click(await screen.findByText('Shredded ledger'));

    // The detail view repeats the title; card and detail both fall back to the
    // neutral impact.
    expect(await screen.findAllByText('Shredded ledger')).toHaveLength(2);
    expect(screen.getAllByText('NEUTRAL')).toHaveLength(2);
  });
});
