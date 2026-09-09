// Obfuscation: found, located, and quantified -- not undone.
//
// Full automatic control-flow unflattening is a research problem. There is no
// turnkey headless tool for it: D-810 does it well but at IDA decompilation
// time, as a GUI plugin. Promising "deobfuscated" output here would be a lie,
// and the whole point of this stack is that it does not lie.
//
// So this does the part that IS reliable and is most of the analyst's time
// anyway: say WHICH functions are obfuscated, WHAT construct is in them, how
// strong the signal is, and what would undo it. An analyst who knows that three
// of four hundred functions are flattened, and which three, has had the hard
// part of the search done for them.
//
// Every finding names its evidence. A confidence is attached because these are
// heuristics over decompiler output and saying otherwise would overstate them.

export type GhidraObfuscationCode =
  | 'control_flow_flattening'
  | 'opaque_predicates'
  | 'mixed_boolean_arithmetic'
  | 'junk_jumps'
  | 'packer_sections'
  | 'high_entropy_section';

export type GhidraObfuscationConfidence = 'strong' | 'moderate' | 'weak';

export interface GhidraObfuscationFinding {
  code: GhidraObfuscationCode;
  /** The function it was found in, or '' for a whole-image finding. */
  functionName: string;
  address: string;
  confidence: GhidraObfuscationConfidence;
  detail: string;
  /** The lines or names that produced the verdict. */
  evidence: string[];
  /** What would actually undo it, said plainly. */
  remedy: string;
}

export interface GhidraObfuscationBody {
  name: string;
  address: string;
  decompiled: string;
}

/** A dispatcher assigns a state variable and switches on it, inside a loop. */
const SWITCH_REGEX = /\bswitch\s*\(/;
const LOOP_REGEX = /\bwhile\s*\(\s*(?:true|1|[a-zA-Z_]\w*\s*!=\s*0)\s*\)|\bfor\s*\(\s*;\s*;/;
const STATE_ASSIGN_REGEX = /\b([a-zA-Z_]\w*)\s*=\s*(?:0x[0-9a-fA-F]+|-?\d+)\s*;/g;

/** Bitwise operators, the raw material of MBA. */
const BITWISE_REGEX = /[\^&|]|<<|>>/g;
const STATEMENT_REGEX = /;/g;

/** A comparison of two constants can only go one way. */
const CONSTANT_COMPARE_REGEX =
  /\bif\s*\(\s*(?:0x[0-9a-fA-F]+|\d+)\s*(?:==|!=|<|>|<=|>=)\s*(?:0x[0-9a-fA-F]+|\d+)\s*\)/;
/** `(x * x) % 2 == 0` and friends: always true, and a classic opaque predicate. */
const OPAQUE_ALGEBRA_REGEX = /\(\s*([a-zA-Z_]\w*)\s*\*\s*\1\s*[)\s]*[%&]\s*[12]\b/;

const PACKER_SECTION_REGEX =
  /^(?:upx[0-9!]?|\.aspack|\.adata|\.themida|\.vmp[0-9]?|\.enigma[0-9]?|\.petite|\.nsp[0-9]?|\.mpress[0-9]?|\.boom|\.taz|\.sforce)/i;

/** How much of a function must be bitwise before it reads as MBA rather than as maths. */
const MBA_OPS_PER_STATEMENT = 4;
const MBA_MIN_STATEMENTS = 8;

function countMatches(text: string, regex: RegExp): number {
  return (text.match(regex) ?? []).length;
}

/** The lines that actually contain the construct, for the evidence list. */
function linesMatching(text: string, regex: RegExp, limit = 4): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && regex.test(trimmed)) {
      found.push(trimmed.slice(0, 160));
      if (found.length >= limit) {
        break;
      }
    }
  }
  return found;
}

/**
 * Control-flow flattening: one dispatcher loop, one state variable, many cases.
 *
 * The shape is what gives it away rather than any single line -- a `switch`
 * inside an unconditional loop, with the switched-on variable reassigned in most
 * of the cases. Ordinary code has switches and it has loops; it very rarely has
 * a switch whose subject is rewritten by nearly every arm.
 */
function detectFlattening(body: GhidraObfuscationBody): GhidraObfuscationFinding | null {
  const text = body.decompiled;
  if (!SWITCH_REGEX.test(text) || !LOOP_REGEX.test(text)) {
    return null;
  }
  const cases = countMatches(text, /\bcase\s+/g);
  if (cases < 5) {
    return null;
  }
  // Which variable is reassigned to a constant most often? In a flattened
  // function that is the state variable, and it dominates.
  const assignments = new Map<string, number>();
  for (const match of text.matchAll(STATE_ASSIGN_REGEX)) {
    assignments.set(match[1], (assignments.get(match[1]) ?? 0) + 1);
  }
  let stateVar = '';
  let stateAssignments = 0;
  for (const [name, count] of assignments) {
    if (count > stateAssignments) {
      stateVar = name;
      stateAssignments = count;
    }
  }
  if (stateAssignments < Math.max(3, Math.floor(cases / 2))) {
    return null;
  }
  const confidence: GhidraObfuscationConfidence =
    stateAssignments >= cases && cases >= 10 ? 'strong' : 'moderate';
  return {
    code: 'control_flow_flattening',
    functionName: body.name,
    address: body.address,
    confidence,
    detail: `A dispatcher loop switches on \`${stateVar}\` across ${cases} cases, and \`${stateVar}\` is reassigned to a constant ${stateAssignments} times. That is the shape of O-LLVM-style control-flow flattening: the original basic-block order is in the state values, not in the code.`,
    evidence: linesMatching(text, new RegExp(`\\b${stateVar}\\s*=`), 4),
    remedy:
      'Unflattening needs symbolic execution over the dispatcher. D-810 (IDA Pro, decompilation-time microcode rewriting) does this; there is no headless Ghidra equivalent, so this function is reported rather than restored.',
  };
}

function detectOpaquePredicates(body: GhidraObfuscationBody): GhidraObfuscationFinding | null {
  const text = body.decompiled;
  const constantCompares = linesMatching(text, CONSTANT_COMPARE_REGEX, 6);
  const algebraic = linesMatching(text, OPAQUE_ALGEBRA_REGEX, 6);
  const total = constantCompares.length + algebraic.length;
  if (total < 2) {
    return null;
  }
  return {
    code: 'opaque_predicates',
    functionName: body.name,
    address: body.address,
    confidence: total >= 4 ? 'moderate' : 'weak',
    detail: `${total} branches whose condition cannot vary at run time. These exist to grow the control-flow graph; the arms they guard are unreachable, so a reader following them is following inserted code.`,
    evidence: [...algebraic, ...constantCompares].slice(0, 6),
    remedy:
      'Constant-fold the conditions and drop the dead arms. Ghidra does some of this already; the rest is manual or a decompiler plugin.',
  };
}

function detectMba(body: GhidraObfuscationBody): GhidraObfuscationFinding | null {
  const text = body.decompiled;
  const statements = countMatches(text, STATEMENT_REGEX);
  if (statements < MBA_MIN_STATEMENTS) {
    return null;
  }
  const bitwise = countMatches(text, BITWISE_REGEX);
  const density = bitwise / statements;
  if (density < MBA_OPS_PER_STATEMENT) {
    return null;
  }
  return {
    code: 'mixed_boolean_arithmetic',
    functionName: body.name,
    address: body.address,
    confidence: density >= MBA_OPS_PER_STATEMENT * 1.5 ? 'moderate' : 'weak',
    detail: `${bitwise} bitwise operations across ${statements} statements (${density.toFixed(1)} per statement). Arithmetic rewritten as boolean identities reads as noise; the underlying expression is usually far smaller.`,
    evidence: linesMatching(text, /[\^&|]|<<|>>/, 4),
    remedy:
      'MBA simplifiers (gooMBA, D-810 rules, or an SMT solver) reduce these back to the original expression.',
  };
}

/** Whole-image findings: sections, not functions. */
export function detectSectionObfuscation(params: {
  sectionNames?: readonly string[];
  entropyBySection?: Readonly<Record<string, number>>;
}): GhidraObfuscationFinding[] {
  const findings: GhidraObfuscationFinding[] = [];
  const packer = (params.sectionNames ?? []).filter((name) =>
    PACKER_SECTION_REGEX.test(name.trim()),
  );
  if (packer.length > 0) {
    findings.push({
      code: 'packer_sections',
      functionName: '',
      address: '',
      confidence: 'strong',
      detail: `Section names match a known packer or protector: ${packer.join(', ')}. The code Ghidra decompiled is the stub, not the payload.`,
      evidence: packer.slice(0, 8),
      remedy:
        'Unpack first -- run it under a monitor and dump from memory, or use the packer-specific unpacker. Static analysis of a packed image describes the loader only.',
    });
  }
  for (const [name, entropy] of Object.entries(params.entropyBySection ?? {})) {
    if (entropy >= 7.2) {
      findings.push({
        code: 'high_entropy_section',
        functionName: '',
        address: '',
        confidence: entropy >= 7.5 ? 'moderate' : 'weak',
        detail: `Section \`${name}\` has entropy ${entropy.toFixed(2)} of a possible 8. That is compressed or encrypted content, not code the decompiler can read.`,
        evidence: [`${name}: ${entropy.toFixed(2)}`],
        remedy:
          'Locate the routine that decompresses or decrypts it and recover the payload from there.',
      });
    }
  }
  return findings;
}

/**
 * Every construct found, per function, ordered by how much it matters.
 *
 * Flattening first: it is the one that makes a function genuinely unreadable,
 * and the one worth spending a tool on.
 */
export function detectObfuscation(params: {
  bodies: readonly GhidraObfuscationBody[];
  sectionNames?: readonly string[];
  entropyBySection?: Readonly<Record<string, number>>;
}): GhidraObfuscationFinding[] {
  const findings: GhidraObfuscationFinding[] = [
    ...detectSectionObfuscation({
      ...(params.sectionNames ? { sectionNames: params.sectionNames } : {}),
      ...(params.entropyBySection ? { entropyBySection: params.entropyBySection } : {}),
    }),
  ];
  for (const body of params.bodies) {
    if (!body.decompiled.trim()) {
      continue;
    }
    for (const detect of [detectFlattening, detectOpaquePredicates, detectMba]) {
      const finding = detect(body);
      if (finding) {
        findings.push(finding);
      }
    }
  }
  const rank: Record<GhidraObfuscationCode, number> = {
    packer_sections: 0,
    control_flow_flattening: 1,
    high_entropy_section: 2,
    mixed_boolean_arithmetic: 3,
    opaque_predicates: 4,
    junk_jumps: 5,
  };
  const weight: Record<GhidraObfuscationConfidence, number> = {
    strong: 0,
    moderate: 1,
    weak: 2,
  };
  return findings.sort(
    (left, right) =>
      rank[left.code] - rank[right.code] ||
      weight[left.confidence] - weight[right.confidence] ||
      left.functionName.localeCompare(right.functionName),
  );
}
