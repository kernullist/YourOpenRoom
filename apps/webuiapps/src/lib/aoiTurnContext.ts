// The decisions a turn makes from its reading: which route, which tool
// families, whether to ask instead of act, and how the recent turns and the
// reading are shown to the model.
//
// Pulled out of ChatPanel.runConversation so each decision is a pure function
// with a test, and so the reasons behind them are recorded rather than living
// in console.info. The floor is the regex router: nothing here can send a turn
// to the dialog route that the regex would have sent to main, or remove a tool
// family the regex would have exposed. The classifier and the model's own
// request_capabilities call can only add.

import type { ToolDef } from './llmClient';
import type { AoiRunLedgerUnderstanding } from './aoiRunLedger';
import {
  AOI_CAPABILITY_FAMILIES,
  AOI_SIDE_EFFECT_FAMILIES,
  type AoiCapabilityFamily,
  type AoiTurnRecord,
} from './aoiTurnRecord';
import type { AoiTurnUnderstanding } from './aoiTurnUnderstanding';

/** The reading as the run ledger stores it; undefined when there was none. */
export function toAoiRunLedgerUnderstanding(
  understanding: AoiTurnUnderstanding | null | undefined,
): AoiRunLedgerUnderstanding | undefined {
  if (!understanding) {
    return undefined;
  }
  return {
    source: understanding.source,
    kind: understanding.kind,
    families: [...understanding.families],
    confidence: understanding.confidence,
    refersToTurn: understanding.refersToTurn,
    referent: understanding.referent,
    ...(typeof understanding.latencyMs === 'number' ? { latencyMs: understanding.latencyMs } : {}),
  };
}

export type AoiTurnRouteLayer =
  | 'attachment'
  | 'contract'
  | 'escalation'
  | 'no_dialog_config'
  | 'classifier'
  | 'regex';

export interface AoiTurnRouteDecision {
  route: 'dialog' | 'main';
  reason: string;
  layer: AoiTurnRouteLayer;
  // Tool families the turn should carry beyond what the regex flags already
  // expose. Empty when nothing was added.
  families: AoiCapabilityFamily[];
}

export interface AoiCapabilityEscalation {
  families: AoiCapabilityFamily[];
  reason: string;
}

function realFamilies(families: readonly AoiCapabilityFamily[]): AoiCapabilityFamily[] {
  return [...new Set(families.filter((family) => family !== 'none'))];
}

/**
 * Whether the classifier's reading is strong enough to change a routing or
 * tool decision. Only a high-confidence reading naming a real family may; a
 * medium or low reading, or a reading with no family, is shown to the model as
 * context but never moves a tool. Plain boolean on purpose: a type guard here
 * would narrow the false branch to null, which is not what false means.
 */
export function isActionableAoiUnderstanding(
  understanding: AoiTurnUnderstanding | null | undefined,
): boolean {
  return (
    !!understanding &&
    understanding.source === 'classifier' &&
    understanding.confidence === 'high' &&
    realFamilies(understanding.families).length > 0
  );
}

export function resolveAoiTurnRoute(params: {
  hasAttachments: boolean;
  outcomeFeedbackContract: boolean;
  dialogAvailable: boolean;
  regexDialog: boolean;
  understanding: AoiTurnUnderstanding | null;
  escalation: AoiCapabilityEscalation | null;
}): AoiTurnRouteDecision {
  if (params.hasAttachments) {
    return {
      route: 'main',
      reason: 'attachment: image turns use the main model',
      layer: 'attachment',
      families: [],
    };
  }
  if (params.outcomeFeedbackContract) {
    return {
      route: 'main',
      reason: 'contract: outcome feedback needs the main model',
      layer: 'contract',
      families: [],
    };
  }
  if (params.escalation) {
    const families = realFamilies(params.escalation.families);
    return {
      route: 'main',
      reason: `escalation: model requested ${families.join(',') || 'main route'}`,
      layer: 'escalation',
      families,
    };
  }
  if (!params.dialogAvailable) {
    return { route: 'main', reason: 'no dialog config', layer: 'no_dialog_config', families: [] };
  }
  const understanding = params.understanding;
  const actionable = understanding !== null && isActionableAoiUnderstanding(understanding);
  if (!params.regexDialog) {
    const families = actionable && understanding ? realFamilies(understanding.families) : [];
    return {
      route: 'main',
      reason:
        families.length > 0 ? `regex: main; classifier adds ${families.join(',')}` : 'regex: main',
      layer: 'regex',
      families,
    };
  }
  if (actionable && understanding) {
    const families = realFamilies(understanding.families);
    // A reading whose kind is conversational but names a family ("what does this
    // file do?") is a request for information that needs a tool to answer; it
    // goes to main as well. Only a no-family reading stays on dialog, and that
    // case is excluded by isActionableAoiUnderstanding above.
    return {
      route: 'main',
      reason: `classifier: ${understanding.kind} needs ${families.join(',')}; pulled from dialog`,
      layer: 'classifier',
      families,
    };
  }
  const readingNote =
    understanding && understanding.source === 'classifier'
      ? `; classifier ${understanding.kind}/${understanding.confidence}`
      : '';
  return { route: 'dialog', reason: `regex: dialog${readingNote}`, layer: 'regex', families: [] };
}

export interface AoiTurnToolFlags {
  includeAppTools: boolean;
  includeIdaTools: boolean;
  includeGhidraTools: boolean;
}

/**
 * Merge the regex tool flags with the families a high-confidence reading or an
 * escalation named. Regex flags are the floor; families can only turn a flag on.
 */
export function resolveAoiTurnToolFlags(params: {
  regex: AoiTurnToolFlags;
  families: readonly AoiCapabilityFamily[];
}): AoiTurnToolFlags & { added: string[] } {
  const families = new Set(realFamilies(params.families));
  const added: string[] = [];
  const includeAppTools =
    params.regex.includeAppTools ||
    families.has('app') ||
    families.has('file') ||
    families.has('command');
  if (includeAppTools && !params.regex.includeAppTools) {
    added.push('app');
  }
  const includeIdaTools = params.regex.includeIdaTools || families.has('ida');
  if (includeIdaTools && !params.regex.includeIdaTools) {
    added.push('ida');
  }
  const includeGhidraTools = params.regex.includeGhidraTools || families.has('ghidra');
  if (includeGhidraTools && !params.regex.includeGhidraTools) {
    added.push('ghidra');
  }
  return { includeAppTools, includeIdaTools, includeGhidraTools, added };
}

// ---------------------------------------------------------------------------
// request_capabilities: the model's own escape from a misrouted dialog turn
// ---------------------------------------------------------------------------

export const AOI_REQUEST_CAPABILITIES_TOOL_NAME = 'request_capabilities';
export const MAX_AOI_CAPABILITY_ESCALATIONS = 1;
const MAX_ESCALATION_REASON_CHARS = 160;

export function getAoiRequestCapabilitiesToolDefinition(): ToolDef {
  return {
    type: 'function',
    function: {
      name: AOI_REQUEST_CAPABILITIES_TOOL_NAME,
      description:
        'Call this INSTEAD of answering when the user asked for something that needs tools not in this turn: files or the IDE workspace, shell/build/test commands, the real browser or a URL, PC programs and processes, IDA/Ghidra binary analysis, web research, memory, or image generation. The turn is re-run with those tools. Do not call it for conversation, for questions you can answer, or for in-room app actions (list_apps and app_action are already here).',
      parameters: {
        type: 'object',
        properties: {
          families: {
            type: 'array',
            items: {
              type: 'string',
              enum: AOI_CAPABILITY_FAMILIES.filter((family) => family !== 'none'),
            },
            description: 'The capability families the request needs.',
          },
          reason: {
            type: 'string',
            description: 'One short sentence: what the user asked for that needs them.',
          },
        },
        required: ['families'],
      },
    },
  };
}

export function parseAoiRequestCapabilitiesParams(raw: unknown): AoiCapabilityEscalation | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as { families?: unknown; reason?: unknown };
  if (!Array.isArray(record.families)) {
    return null;
  }
  const families: AoiCapabilityFamily[] = [];
  for (const item of record.families) {
    if (typeof item !== 'string') {
      continue;
    }
    const value = item.trim().toLowerCase() as AoiCapabilityFamily;
    if (value !== 'none' && AOI_CAPABILITY_FAMILIES.includes(value) && !families.includes(value)) {
      families.push(value);
    }
  }
  if (families.length === 0) {
    return null;
  }
  const reason = typeof record.reason === 'string' ? record.reason.replace(/\s+/g, ' ').trim() : '';
  return {
    families,
    reason:
      reason.length > MAX_ESCALATION_REASON_CHARS
        ? `${reason.slice(0, MAX_ESCALATION_REASON_CHARS)}...`
        : reason,
  };
}

/**
 * The policy paragraph for a dialog-route turn that carries request_capabilities.
 * It replaces the five separate regex escape hatches with one instruction: when
 * the tools are missing, ask the runtime for them instead of telling the user
 * they do not exist.
 */
export function buildAoiRequestCapabilitiesPolicyPrompt(): string {
  return `

Missing capabilities this turn:
- This turn carries only conversation tools plus list_apps/app_action. If the user asked for something that needs files, the IDE workspace, shell or build commands, the real browser or a URL, PC programs or processes, IDA/Ghidra analysis, web research, memory, or image generation, call ${AOI_REQUEST_CAPABILITIES_TOOL_NAME} with the families it needs and nothing else. The turn is re-run with those tools and you answer then.
- Never tell the user a capability is unavailable, and never promise it for a later turn, without having called ${AOI_REQUEST_CAPABILITIES_TOOL_NAME} first.
- Do not call it for ordinary conversation, for a question you can answer from what you know, or for in-room app actions.`;
}

// ---------------------------------------------------------------------------
// Clarification
// ---------------------------------------------------------------------------

export type AoiClarificationDecision =
  | { ask: true; question: string; options: string[] }
  | { ask: false; reason: string };

/**
 * Whether to ask one question instead of running the turn.
 *
 * Only when the reading came from the classifier at low confidence, the user
 * wants something DONE, at least one named family changes something outside the
 * conversation, the classifier supplied the question, and the previous turn was
 * not already a question -- two questions in a row is a loop, not a clarification.
 */
export function decideAoiClarification(params: {
  understanding: AoiTurnUnderstanding | null;
  previousRecord: AoiTurnRecord | null;
}): AoiClarificationDecision {
  const understanding = params.understanding;
  if (!understanding || understanding.source !== 'classifier') {
    return { ask: false, reason: 'no classifier reading' };
  }
  if (understanding.confidence !== 'low') {
    return { ask: false, reason: `confidence ${understanding.confidence}` };
  }
  if (understanding.kind !== 'action_request') {
    return { ask: false, reason: `kind ${understanding.kind}` };
  }
  const sideEffect = realFamilies(understanding.families).some((family) =>
    AOI_SIDE_EFFECT_FAMILIES.has(family),
  );
  if (!sideEffect) {
    return { ask: false, reason: 'no side-effect family' };
  }
  const question = understanding.needsClarification?.trim() ?? '';
  if (!question) {
    return { ask: false, reason: 'classifier gave no question' };
  }
  if (params.previousRecord?.outcome === 'clarification_asked') {
    return { ask: false, reason: 'previous turn already asked' };
  }
  return { ask: true, question, options: understanding.clarificationOptions.slice(0, 3) };
}

// ---------------------------------------------------------------------------
// Prompt block
// ---------------------------------------------------------------------------

function describeReferenceTurn(
  understanding: AoiTurnUnderstanding,
  records: readonly AoiTurnRecord[],
): string {
  if (understanding.refersToTurn === null) {
    return '';
  }
  const index = records.findIndex((record) => record.turnIndex === understanding.refersToTurn);
  if (index < 0) {
    return '';
  }
  const position = records.length - index;
  return understanding.referent
    ? `; refers to T-${position} (${JSON.stringify(understanding.referent)})`
    : `; refers to T-${position}`;
}

/**
 * The per-turn context block: the recent turns, then the classifier's reading
 * of the latest message when it is worth stating. A regex reading is not shown
 * -- it is the router's own heuristic, not information the model lacks.
 */
export function buildAoiTurnContextPromptBlock(params: {
  recentTurnsBlock: string;
  understanding: AoiTurnUnderstanding | null;
  records: readonly AoiTurnRecord[];
}): string {
  let block = params.recentTurnsBlock;
  const understanding = params.understanding;
  if (
    understanding &&
    understanding.source === 'classifier' &&
    understanding.confidence !== 'low'
  ) {
    const families = realFamilies(understanding.families);
    const lines = [
      '',
      '',
      'Reading of the latest user message (runtime classifier, may be wrong; the message itself wins):',
      `- kind: ${understanding.kind}${families.length > 0 ? `; needs: ${families.join(', ')}` : ''}${describeReferenceTurn(understanding, params.records)}.`,
    ];
    if (understanding.kind === 'confirmation') {
      lines.push(
        '- The user is saying yes to what Aoi last asked or offered. Do that now; do not ask again.',
      );
    } else if (understanding.kind === 'rejection_or_correction') {
      lines.push(
        '- The user is refusing or correcting the previous turn. Do not repeat what was refused; pick up the alternative they mean, or ask which.',
      );
    } else if (understanding.kind === 'action_request' && understanding.refersToTurn !== null) {
      lines.push(
        '- The request targets the thing from the referenced turn above. Use that exact target; do not ask for it again.',
      );
    }
    block += lines.join('\n');
  }
  return block;
}
