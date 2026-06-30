// Server-capable reflection chat for the autonomy loop.
//
// The autonomy engine's default chat is the BROWSER client (`llmClient.chat`),
// which posts to the relative '/api/llm-proxy' URL. That URL only resolves in a
// browser (same-origin); in the server-side autonomy loop (Vite plugin / daemon
// / HTTP routes, all Node) it throws "Invalid URL" and the LLM reflection / brief
// / goal synthesis silently fall back to deterministic. This adapter routes the
// reflection through the SERVER-side caller (`callAoiMainTextModel`, which fetches
// the provider's absolute baseUrl directly), so the LLM path actually reaches a
// model when the loop runs with network access.
//
// Server-only. The reflection/brief prompts are JSON-output oriented, so the
// adapter requests JSON mode and flattens the [system, user] messages into a
// single prompt (the reflection path never passes tools).
import { callAoiMainTextModel } from './dewdropCanvasPlugin';
import { isAoiServerCliProvider, runAoiServerCliChat } from './aoiCliChatServer';
import type { AoiAutonomyReflectionChat } from './aoiAutonomyEngine';

const AOI_REFLECTION_MAX_OUTPUT_TOKENS = 1500;

// serverOrigin is the default dev origin for the baseUrl proxy path; baseUrl
// providers (OpenAI / OpenRouter / Anthropic) call their absolute endpoint
// directly. CLI / managed-auth providers (codex-auth, codex-cli, claude-cli) no
// longer proxy through `${serverOrigin}/api/...` -- they spawn the CLI in-process
// (runAoiServerCliChat), which is what lets the LLM path reach the model under the
// standalone daemon, not only under `pnpm dev` (where the Vite endpoints exist).
export const DEFAULT_AOI_REFLECTION_SERVER_ORIGIN = 'http://127.0.0.1:3000';

function flattenMessagesToPrompt(messages: Parameters<AoiAutonomyReflectionChat>[0]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === 'string' ? message.content : '';
      return `[${message.role}]\n${content}`;
    })
    .join('\n\n')
    .trim();
}

export function createAoiAutonomyReflectionChat(
  serverOrigin: string = DEFAULT_AOI_REFLECTION_SERVER_ORIGIN,
  workspaceRoot?: string,
): AoiAutonomyReflectionChat {
  return async (messages, _tools, config) => {
    const prompt = flattenMessagesToPrompt(messages);
    // CLI / managed-auth providers: spawn the CLI in-process (the daemon is Node;
    // the HTTP chat endpoints are a browser bridge). This is the B1 daemon LLM-path
    // fix. workspaceRoot is the codex `--cd` / cwd; fall back to the process cwd.
    if (isAoiServerCliProvider(config.provider)) {
      const content = await runAoiServerCliChat(config, prompt, {
        root: workspaceRoot ?? process.cwd(),
      });
      return { content, toolCalls: [] };
    }
    const content = await callAoiMainTextModel(
      config,
      serverOrigin,
      prompt,
      AOI_REFLECTION_MAX_OUTPUT_TOKENS,
      true,
    );
    return { content, toolCalls: [] };
  };
}
