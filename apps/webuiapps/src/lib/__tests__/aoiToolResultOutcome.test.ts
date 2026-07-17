import { describe, expect, it } from 'vitest';

import { classifyAoiToolResult } from '../aoiToolResultOutcome';

describe('classifyAoiToolResult', () => {
  it('classifies safe-command policy errors and non-zero exits as failures', () => {
    expect(classifyAoiToolResult('error: command is not allowed').failed).toBe(true);
    expect(classifyAoiToolResult(JSON.stringify({ exitCode: 1, stderr: 'test failed' }))).toEqual({
      failed: true,
      message: 'exitCode=1: test failed',
    });
    expect(classifyAoiToolResult(JSON.stringify({ status: 'failed', message: 'blocked' }))).toEqual(
      {
        failed: true,
        message: 'blocked',
      },
    );
  });

  it('accepts successful JSON and plain-text results', () => {
    expect(classifyAoiToolResult(JSON.stringify({ ok: true, path: 'a.md' })).failed).toBe(false);
    expect(classifyAoiToolResult('Message delivered.').failed).toBe(false);
  });
});
