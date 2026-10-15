/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClarificationCard } from './ClarificationCard';
import type { ParseAmbiguity, ParsedFlightQuery } from '@/lib/scraper/parse-query';
import type { ConversationMessage } from '@/lib/clarification-types';

function makeAmbiguities(): ParseAmbiguity[] {
  return [
    {
      field: 'date',
      question: "That's a 9-day return window. Pick a specific return date or narrow the range.",
    },
  ];
}

function makePartial(): ParsedFlightQuery {
  return {
    origin: 'JFK',
    originName: 'JFK',
    destination: 'LAX',
    destinationName: 'LAX',
    origins: [{ code: 'JFK', name: 'JFK' }],
    destinations: [{ code: 'LAX', name: 'LAX' }],
    dateFrom: '2026-03-01',
    dateTo: '2026-03-25',
    flexibility: 0,
    maxPrice: null,
    maxStops: null,
    maxDurationHours: null,
    preferredAirlines: [],
    timePreference: 'any',
    cabinClass: 'economy',
    tripType: 'round_trip',
    currency: null,
  };
}

describe('ClarificationCard', () => {
  it('renders the active question without history when conversation is empty', () => {
    render(
      <ClarificationCard
        ambiguities={makeAmbiguities()}
        partialParsed={makePartial()}
        onAnswer={vi.fn().mockResolvedValue(true)}
        onReset={vi.fn()}
        loading={false}
      />,
    );

    // The active question appears in the form (visible <p> + visually-hidden <label>).
    expect(screen.getAllByText(/9-day return window/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Clarification history')).not.toBeInTheDocument();
  });

  it('renders prior turns above the active question and excludes the active turn', () => {
    const conversation: ConversationMessage[] = [
      { role: 'user', content: 'JFK to LAX March 1, return March 15-27' },
      { role: 'assistant', content: 'That was a 12-day window. Narrow it down.' },
      { role: 'user', content: 'March 15-21' },
      // The active question, which should be excluded from history.
      { role: 'assistant', content: "That's a 9-day return window. Pick a specific return date or narrow the range." },
    ];

    render(
      <ClarificationCard
        ambiguities={makeAmbiguities()}
        partialParsed={makePartial()}
        conversation={conversation}
        onAnswer={vi.fn().mockResolvedValue(true)}
        onReset={vi.fn()}
        loading={false}
      />,
    );

    const history = screen.getByLabelText('Clarification history');
    expect(history).toBeInTheDocument();

    // History should include the prior turns.
    expect(screen.getByText(/12-day window/)).toBeInTheDocument();
    expect(screen.getByText('March 15-21')).toBeInTheDocument();
    expect(screen.getByText('JFK to LAX March 1, return March 15-27')).toBeInTheDocument();

    // Active question must NOT appear inside the history block (it's only in the active form).
    expect(history.textContent).not.toMatch(/9-day return window/);
  });

  it('submits the typed answer when the user clicks submit', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(true);

    render(
      <ClarificationCard
        ambiguities={makeAmbiguities()}
        partialParsed={makePartial()}
        onAnswer={onAnswer}
        onReset={vi.fn()}
        loading={false}
      />,
    );

    const input = screen.getByPlaceholderText(/type your answer/i);
    await user.type(input, 'March 17');
    await user.click(screen.getByRole('button', { name: /submit answers/i }));

    expect(onAnswer).toHaveBeenCalledWith('March 17');
  });
});
