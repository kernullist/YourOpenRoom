import { describe, expect, it } from 'vitest';

import {
  buildAoiFileTaskCorrectionPrompt,
  createAoiFileTaskEvidence,
  observeAoiFileTaskToolResult,
  parseAoiFileTaskContract,
  resolveAoiFileTaskContract,
  shouldEnforceAoiFileTaskContract,
  verifyAoiFileTaskContract,
} from '../aoiFileTaskContract';

const REQUEST = `JARVIS/NON_VOICE_90_PROGRESS.md를 읽고
written-by-me/output/aoi-field-status.md를 새로 만들어줘.

요구사항:
- 전체 20줄 이내
- 실행 전 preview 후 내 승인을 기다릴 것
- 승인 후 작성 결과를 다시 읽어 검증
- SHA-256과 실제 변경 파일 목록 보고
- 다른 파일은 수정하지 말 것`;

describe('aoiFileTaskContract', () => {
  it('extracts target scope and deterministic completion requirements', () => {
    const contract = parseAoiFileTaskContract(REQUEST);

    expect(contract).toMatchObject({
      targetPaths: ['written-by-me/output/aoi-field-status.md'],
      maxLines: 20,
      requireReadBack: true,
      requireSha256: true,
      requireChangedFileList: true,
      previewRequired: true,
    });
  });

  it('does not turn a read-only hash request into a mutation contract', () => {
    expect(
      parseAoiFileTaskContract('README.md를 읽고 SHA-256을 보고해. 어떤 파일도 수정하지 말 것.'),
    ).toBeNull();
    expect(
      parseAoiFileTaskContract(
        'README.md를 읽고 SHA-256을 보고해. 새 파일을 생성하지 말고 기존 파일도 수정하지 말 것.',
      ),
    ).toBeNull();
  });

  it('carries the previous file contract across a short approval turn', () => {
    const contract = resolveAoiFileTaskContract({
      latestUserMessage: '응 진행해',
      history: [
        { role: 'user', content: REQUEST },
        { role: 'assistant', content: 'Preview complete. Proceed?' },
        { role: 'user', content: '응 진행해' },
      ],
      confirmedActionRequest: 'Create the previewed file now.',
    });

    expect(contract?.maxLines).toBe(20);
    expect(contract?.targetPaths).toEqual(['written-by-me/output/aoi-field-status.md']);
  });

  it('allows the required preview turn but enforces the approved execution turn', () => {
    const contract = parseAoiFileTaskContract(REQUEST);
    const evidence = createAoiFileTaskEvidence();

    expect(shouldEnforceAoiFileTaskContract(contract, evidence, false)).toBe(false);
    expect(shouldEnforceAoiFileTaskContract(contract, evidence, true)).toBe(true);
  });

  it('invalidates pre-write reads and blocks oversized artifacts without a verified hash report', () => {
    const contract = parseAoiFileTaskContract(REQUEST);
    let evidence = createAoiFileTaskEvidence();
    evidence = observeAoiFileTaskToolResult(
      evidence,
      'ide_read_file',
      { path: 'written-by-me/output/aoi-field-status.md' },
      JSON.stringify({
        path: 'written-by-me/output/aoi-field-status.md',
        line_count: 10,
        sha256: 'a'.repeat(64),
        content: 'old',
      }),
    );
    evidence = observeAoiFileTaskToolResult(
      evidence,
      'ide_write_file',
      { path: 'written-by-me/output/aoi-field-status.md' },
      JSON.stringify({ ok: true, path: 'written-by-me/output/aoi-field-status.md' }),
    );
    evidence = observeAoiFileTaskToolResult(
      evidence,
      'ide_read_file',
      { path: 'written-by-me/output/aoi-field-status.md' },
      JSON.stringify({
        path: 'written-by-me/output/aoi-field-status.md',
        source: 'disk',
        line_count: 39,
        char_count: 1_097,
        sha256: 'b'.repeat(64),
        content: 'new',
      }),
    );

    const verification = verifyAoiFileTaskContract({
      contract,
      evidence,
      assistantContent: 'changed written-by-me/output/aoi-field-status.md',
      executionConfirmed: true,
    });

    expect(verification.passed).toBe(false);
    expect(verification.issues).toContain(
      'written-by-me/output/aoi-field-status.md has 39 lines; maximum is 20',
    );
    expect(verification.issues).toContain(
      'final response does not report the verified SHA-256 for written-by-me/output/aoi-field-status.md',
    );
  });

  it('passes only after final read-back evidence and exact reporting are complete', () => {
    const contract = parseAoiFileTaskContract(REQUEST);
    const hash = '9a158ef0d66a5a66bb8939c2895eeae3bf34a7629fb5649593b0c71f6e8101ae';
    let evidence = createAoiFileTaskEvidence();
    evidence = observeAoiFileTaskToolResult(
      evidence,
      'ide_write_file',
      { path: 'written-by-me/output/aoi-field-status.md' },
      JSON.stringify({ ok: true, path: 'written-by-me/output/aoi-field-status.md' }),
    );
    evidence = observeAoiFileTaskToolResult(
      evidence,
      'ide_read_file',
      { path: 'written-by-me/output/aoi-field-status.md' },
      JSON.stringify({
        path: 'written-by-me/output/aoi-field-status.md',
        source: 'disk',
        line_count: 18,
        char_count: 700,
        sha256: hash,
        content: 'verified content',
        content_truncated: false,
      }),
    );

    const verification = verifyAoiFileTaskContract({
      contract,
      evidence,
      assistantContent: `Changed files: written-by-me/output/aoi-field-status.md\nSHA-256: ${hash}`,
      executionConfirmed: true,
    });

    expect(verification).toEqual({ passed: true, enforced: true, issues: [] });
  });

  it('turns a blocked completion into an immediate write-read-report recovery sequence', () => {
    const prompt = buildAoiFileTaskCorrectionPrompt(
      {
        passed: false,
        enforced: true,
        issues: ['artifact contains stale current facts'],
      },
      {
        mutatedFiles: ['written-by-me/output/aoi-field-status.md'],
        readBackByPath: {},
      },
    );

    expect(prompt).toContain('next action must be ide_write_file or ide_patch_file');
    expect(prompt).toContain('immediately call ide_read_file');
    expect(prompt).toContain('exact returned SHA-256');
  });
});
