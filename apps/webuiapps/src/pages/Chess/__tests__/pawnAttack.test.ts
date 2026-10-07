import { describe, expect, it, vi } from 'vitest';

// The engine lives in the page module; stub what the component imports so only
// the pure functions are exercised.
vi.mock('./../components/ChessBoard3D', () => ({ default: () => null }));

import { isAttackedBy } from '../index';

type Piece = { type: 'K' | 'Q' | 'R' | 'B' | 'N' | 'P'; color: 'w' | 'b' };

function emptyBoard(): (Piece | null)[][] {
  return Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
}

// Row 0 is black's back rank, row 7 is white's (white pawns advance toward row 0).
describe('isAttackedBy -- pawns', () => {
  it('a white pawn attacks the two squares diagonally ahead of it (toward row 0)', () => {
    const board = emptyBoard();
    board[4][4] = { type: 'P', color: 'w' }; // e4
    expect(isAttackedBy(board, 3, 3, 'w')).toBe(true); // d5
    expect(isAttackedBy(board, 3, 5, 'w')).toBe(true); // f5
    // Not behind it, and not straight ahead.
    expect(isAttackedBy(board, 5, 3, 'w')).toBe(false);
    expect(isAttackedBy(board, 5, 5, 'w')).toBe(false);
    expect(isAttackedBy(board, 3, 4, 'w')).toBe(false);
  });

  it('a black pawn attacks toward row 7, so a king cannot step next to it', () => {
    const board = emptyBoard();
    board[5][4] = { type: 'P', color: 'b' }; // e3
    // f2 and d2 are attacked by the e3 pawn: Ke1-f2 must be illegal.
    expect(isAttackedBy(board, 6, 5, 'b')).toBe(true);
    expect(isAttackedBy(board, 6, 3, 'b')).toBe(true);
    expect(isAttackedBy(board, 4, 3, 'b')).toBe(false);
  });
});
