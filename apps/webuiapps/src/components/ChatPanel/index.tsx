import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Settings, X } from 'lucide-react';
import {
  chat,
  loadConfig,
  loadConfigSync,
  saveConfig,
  getDefaultConfig,
  type LLMConfig,
  type LLMProvider,
  type ChatMessage,
} from '@/lib/llmClient';
import {
  loadImageGenConfig,
  saveImageGenConfig,
  getDefaultImageGenConfig,
  type ImageGenConfig,
  type ImageGenProvider,
} from '@/lib/imageGenClient';
import {
  getAppActionToolDefinition,
  resolveAppAction,
  getListAppsToolDefinition,
  executeListApps,
  APP_REGISTRY,
  loadActionsFromMeta,
} from '@/lib/appRegistry';
import { seedMetaFiles } from '@/lib/seedMeta';
import { dispatchAgentAction, onUserAction } from '@/lib/vibeContainerMock';
import { getFileToolDefinitions, isFileTool, executeFileTool } from '@/lib/fileTools';
import { logger } from '@/lib/logger';
import {
  getImageGenToolDefinitions,
  isImageGenTool,
  executeImageGenTool,
} from '@/lib/imageGenTools';
import styles from './index.module.scss';

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  imageUrl?: string;
}

function buildSystemPrompt(hasImageGen: boolean): string {
  return `You are a helpful assistant that can interact with apps on the user's device. Respond in English by default. If the user writes in another language, switch to that language.

For casual conversation (greetings, questions, chat), just reply naturally without using any tools.

When the user wants to interact with an app:
1. Call list_apps to discover available apps and their appName
2. file_read("apps/{appName}/meta.yaml") to learn available actions
3. file_read("apps/{appName}/guide.md") to learn data structure and JSON schema
4. file_list/file_read to explore data in "apps/{appName}/data/"
5. file_write/file_delete to modify data (follow the JSON schema)
6. app_action to notify the app to reload (e.g. REFRESH_*, SYNC_STATE)

NAS paths in guide.md like "/articles/xxx.json" map to "apps/{appName}/data/articles/xxx.json".
After writing data, ALWAYS call app_action with the corresponding REFRESH action.

When you receive "[User performed action in ... (appName: xxx)]", the appName is already provided. Read its meta.yaml to understand available actions, then respond accordingly. For games, respond with your own move — think strategically.${hasImageGen ? '\n\nYou can also use generate_image to create images from text prompts.' : ''}`;
}

const ChatPanel: React.FC<{ onClose: () => void; visible?: boolean }> = ({
  onClose,
  visible = true,
}) => {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Init from localStorage immediately (sync), then override from local file if available
  const [config, setConfig] = useState<LLMConfig | null>(loadConfigSync);
  const [imageGenConfig, setImageGenConfig] = useState<ImageGenConfig | null>(loadImageGenConfig);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadConfig().then((fileConfig) => {
      if (fileConfig) setConfig(fileConfig);
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const addMessage = useCallback((msg: DisplayMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Use refs to keep latest state for user action listener
  const chatHistoryRef = useRef(chatHistory);
  chatHistoryRef.current = chatHistory;
  const configRef = useRef(config);
  configRef.current = config;
  const imageGenConfigRef = useRef(imageGenConfig);
  imageGenConfigRef.current = imageGenConfig;

  // User action queue + serial processing
  const actionQueueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  const processActionQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (actionQueueRef.current.length > 0) {
      const actionMsg = actionQueueRef.current.shift()!;
      const cfg = configRef.current;
      if (!cfg?.apiKey) break;

      const newHistory: ChatMessage[] = [
        ...chatHistoryRef.current,
        { role: 'user', content: actionMsg },
      ];
      setChatHistory(newHistory);
      setLoading(true);
      try {
        await runConversation(newHistory, cfg);
      } catch (err) {
        logger.error('ChatPanel', 'User action error:', err);
      } finally {
        setLoading(false);
      }
    }
    processingRef.current = false;
  }, []);

  // Listen for user actions reported by apps, auto-send to LLM (e.g. AI needs to respond during a game)
  useEffect(() => {
    const unsubscribe = onUserAction((event: unknown) => {
      const cfg = configRef.current;
      if (!cfg?.apiKey) return;

      const evt = event as {
        app_action?: {
          app_id: number;
          action_type: string;
          params?: Record<string, string>;
          trigger_by?: number;
        };
        action_result?: string;
      };
      logger.info('ChatPanel', 'onUserAction received:', evt);
      // Ignore action_result callbacks (result callbacks triggered by Agent)
      if (evt.action_result !== undefined) {
        logger.info('ChatPanel', 'Ignored: action_result event');
        return;
      }
      const action = evt.app_action;
      if (!action) {
        logger.info('ChatPanel', 'Ignored: no app_action');
        return;
      }
      // Ignore actions triggered by Agent (trigger_by=2)
      if (action.trigger_by === 2) {
        logger.info('ChatPanel', 'Ignored: Agent triggered');
        return;
      }

      const app = APP_REGISTRY.find((a) => a.appId === action.app_id);
      if (!app) return;

      const actionMsg = `[User performed action in ${app.displayName} (appName: ${app.appName})] action_type: ${action.action_type}, params: ${JSON.stringify(action.params || {})}`;
      actionQueueRef.current.push(actionMsg);
      processActionQueue();
    });
    return unsubscribe;
  }, [processActionQueue]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;
    if (!config?.apiKey) {
      setShowSettings(true);
      return;
    }

    const userMsg = input.trim();
    setInput('');

    const userDisplay: DisplayMessage = {
      id: String(Date.now()),
      role: 'user',
      content: userMsg,
    };
    addMessage(userDisplay);

    const newHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: userMsg }];
    setChatHistory(newHistory);

    setLoading(true);
    try {
      await runConversation(newHistory, config);
    } catch (err) {
      logger.error('ChatPanel', 'Error:', err);
      addMessage({
        id: String(Date.now()),
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setLoading(false);
    }
  }, [input, loading, config, chatHistory, addMessage]);

  const runConversation = async (history: ChatMessage[], cfg: LLMConfig) => {
    logger.info(
      'ChatPanel',
      'runConversation called, history length:',
      history.length,
      'provider:',
      cfg.provider,
    );
    await seedMetaFiles();
    await loadActionsFromMeta();
    const hasImageGen = !!imageGenConfigRef.current?.apiKey;
    const tools = [
      getListAppsToolDefinition(),
      getAppActionToolDefinition(),
      ...getFileToolDefinitions(),
      ...(hasImageGen ? getImageGenToolDefinitions() : []),
    ];
    logger.info('ToolLog', 'ChatPanel: tools passed to chat(), count=', tools.length);
    const fullMessages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(hasImageGen) },
      ...history,
    ];

    let currentMessages = fullMessages;
    let iterations = 0;
    const maxIterations = 10;

    logger.info('ChatDebug', '=== START conversation ===');
    logger.info('ChatDebug', 'messages sent to LLM:', JSON.stringify(currentMessages, null, 2));
    logger.info(
      'ChatDebug',
      'tools:',
      tools.map((t) => (t as { function: { name: string } }).function.name),
    );

    while (iterations < maxIterations) {
      iterations++;
      logger.info('ChatDebug', `--- iteration ${iterations} ---`);
      logger.info('ChatDebug', 'messages count:', currentMessages.length);
      const response = await chat(currentMessages, tools, cfg);

      logger.info('ChatDebug', 'LLM response content:', response.content);
      logger.info('ChatDebug', 'LLM toolCalls:', JSON.stringify(response.toolCalls, null, 2));

      if (response.toolCalls.length === 0) {
        // No tool calls, just text response
        if (response.content) {
          addMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: response.content,
          });
          setChatHistory((prev) => [...prev, { role: 'assistant', content: response.content }]);
        }
        break;
      }

      // Has tool calls
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      currentMessages = [...currentMessages, assistantMsg];

      if (response.content) {
        addMessage({
          id: String(Date.now()),
          role: 'assistant',
          content: response.content,
        });
      }

      // Execute each tool call
      logger.info(
        'ToolLog',
        'ChatPanel: executing toolCalls count=',
        response.toolCalls.length,
        'names=',
        response.toolCalls.map((tc) => tc.function.name),
      );
      for (const tc of response.toolCalls) {
        logger.info('ToolLog', 'ChatPanel: processing tool name=', tc.function.name);
        let params: Record<string, string> = {};
        try {
          params = JSON.parse(tc.function.arguments);
        } catch {
          // ignore parse error
        }

        // list_apps tool
        if (tc.function.name === 'list_apps') {
          const result = executeListApps();
          logger.info('ChatDebug', 'list_apps result:', result);
          currentMessages = [
            ...currentMessages,
            { role: 'tool', content: result, tool_call_id: tc.id },
          ];
          continue;
        }

        // File tool calls — direct file operations
        if (isFileTool(tc.function.name)) {
          addMessage({
            id: String(Date.now()) + tc.id,
            role: 'tool',
            content: `Calling ${tc.function.name}...`,
          });
          try {
            const result = await executeFileTool(tc.function.name, params);
            logger.info(
              'ChatDebug',
              `${tc.function.name}(${JSON.stringify(params)}) result:`,
              result.slice(0, 500),
            );
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
            ];
          } catch (err) {
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // Image generation tool call
        if (isImageGenTool(tc.function.name)) {
          addMessage({
            id: String(Date.now()) + tc.id,
            role: 'tool',
            content: 'Generating image...',
          });
          try {
            const { result, dataUrl } = await executeImageGenTool(
              params,
              imageGenConfigRef.current,
            );
            if (dataUrl) {
              addMessage({
                id: String(Date.now()) + '-img',
                role: 'assistant',
                content: '',
                imageUrl: dataUrl,
              });
            }
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
            ];
          } catch (err) {
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // app_action tool
        if (tc.function.name === 'app_action') {
          const resolved = resolveAppAction(params.app_name, params.action_type);
          if (typeof resolved === 'string') {
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: resolved, tool_call_id: tc.id },
            ];
            continue;
          }

          addMessage({
            id: String(Date.now()) + tc.id,
            role: 'tool',
            content: `Calling ${params.app_name}/${params.action_type}...`,
          });

          let actionParams: Record<string, string> = {};
          if (params.params) {
            try {
              actionParams = JSON.parse(params.params);
            } catch {
              // use empty params
            }
          }

          try {
            const result = await dispatchAgentAction({
              app_id: resolved.appId,
              action_type: resolved.actionType,
              params: actionParams,
            });
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
            ];
          } catch (err) {
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // Unknown tool
        currentMessages = [
          ...currentMessages,
          { role: 'tool', content: 'error: unknown tool', tool_call_id: tc.id },
        ];
      }

      // Update chat history with tool interactions
      setChatHistory(currentMessages.slice(1)); // Remove system message
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!visible) return null;

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.header}>
          <span>Chat</span>
          <div className={styles.headerActions}>
            <button
              className={styles.iconBtn}
              onClick={() => setShowSettings(true)}
              title="Settings"
            >
              <Settings size={16} />
            </button>
            <button className={styles.iconBtn} onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className={styles.messages}>
          {messages.length === 0 && (
            <div className={styles.emptyState}>
              {config?.apiKey ? 'Start a conversation...' : 'Click ⚙ to configure your LLM API key'}
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`${styles.message} ${
                msg.role === 'user'
                  ? styles.user
                  : msg.role === 'tool'
                    ? styles.toolInfo
                    : styles.assistant
              }`}
            >
              {msg.content}
              {msg.imageUrl && (
                <img src={msg.imageUrl} alt="Generated" className={styles.messageImage} />
              )}
            </div>
          ))}
          {loading && <div className={styles.loading}>Thinking...</div>}
          <div ref={messagesEndRef} />
        </div>

        <div className={styles.inputArea}>
          <textarea
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            disabled={loading}
          />
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          config={config}
          imageGenConfig={imageGenConfig}
          onSave={(c, igc) => {
            setConfig(c);
            saveConfig(c);
            setImageGenConfig(igc);
            if (igc) {
              saveImageGenConfig(igc);
            }
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </>
  );
};

const SettingsModal: React.FC<{
  config: LLMConfig | null;
  imageGenConfig: ImageGenConfig | null;
  onSave: (_config: LLMConfig, _igConfig: ImageGenConfig | null) => void;
  onClose: () => void;
}> = ({ config, imageGenConfig, onSave, onClose }) => {
  const [provider, setProvider] = useState<LLMProvider>(config?.provider || 'minimax');
  const [apiKey, setApiKey] = useState(config?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl || getDefaultConfig('minimax').baseUrl);
  const [model, setModel] = useState(config?.model || getDefaultConfig('minimax').model);
  const [customHeaders, setCustomHeaders] = useState(config?.customHeaders || '');

  // Image generation settings
  const [igProvider, setIgProvider] = useState<ImageGenProvider>(
    imageGenConfig?.provider || 'gemini',
  );
  const [igApiKey, setIgApiKey] = useState(imageGenConfig?.apiKey || '');
  const [igBaseUrl, setIgBaseUrl] = useState(
    imageGenConfig?.baseUrl || getDefaultImageGenConfig('gemini').baseUrl,
  );
  const [igModel, setIgModel] = useState(
    imageGenConfig?.model || getDefaultImageGenConfig('gemini').model,
  );
  const [igCustomHeaders, setIgCustomHeaders] = useState(imageGenConfig?.customHeaders || '');

  const handleProviderChange = (p: LLMProvider) => {
    setProvider(p);
    const defaults = getDefaultConfig(p);
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
  };

  const handleIgProviderChange = (p: ImageGenProvider) => {
    setIgProvider(p);
    const defaults = getDefaultImageGenConfig(p);
    setIgBaseUrl(defaults.baseUrl);
    setIgModel(defaults.model);
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.settingsModal}>
        <div className={styles.settingsTitle}>LLM Settings</div>

        <div className={styles.field}>
          <label className={styles.label}>Provider</label>
          <select
            className={styles.select}
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as LLMProvider)}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="deepseek">DeepSeek</option>
            <option value="minimax">MiniMax</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>API Key</label>
          <input
            className={styles.fieldInput}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Base URL</label>
          <input
            className={styles.fieldInput}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Model</label>
          <input
            className={styles.fieldInput}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Custom Headers (one per line, Key: Value)</label>
          <textarea
            className={styles.fieldInput}
            value={customHeaders}
            onChange={(e) => setCustomHeaders(e.target.value)}
            placeholder={'X-Custom-Header: value\nAnother-Header: value'}
            rows={3}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
          />
        </div>

        <div className={styles.settingsDivider} />
        <div className={styles.settingsTitle}>Image Generation</div>

        <div className={styles.field}>
          <label className={styles.label}>Provider</label>
          <select
            className={styles.select}
            value={igProvider}
            onChange={(e) => handleIgProviderChange(e.target.value as ImageGenProvider)}
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>API Key</label>
          <input
            className={styles.fieldInput}
            type="password"
            value={igApiKey}
            onChange={(e) => setIgApiKey(e.target.value)}
            placeholder="API Key..."
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Base URL</label>
          <input
            className={styles.fieldInput}
            value={igBaseUrl}
            onChange={(e) => setIgBaseUrl(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Model</label>
          <input
            className={styles.fieldInput}
            value={igModel}
            onChange={(e) => setIgModel(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Custom Headers</label>
          <textarea
            className={styles.fieldInput}
            value={igCustomHeaders}
            onChange={(e) => setIgCustomHeaders(e.target.value)}
            placeholder={'X-Custom-Header: value'}
            rows={2}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
          />
        </div>

        <div className={styles.settingsActions}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.saveBtn}
            onClick={() => {
              const llmCfg: LLMConfig = {
                provider,
                apiKey,
                baseUrl,
                model,
                ...(customHeaders.trim() ? { customHeaders } : {}),
              };
              const igCfg: ImageGenConfig | null = igApiKey.trim()
                ? {
                    provider: igProvider,
                    apiKey: igApiKey,
                    baseUrl: igBaseUrl,
                    model: igModel,
                    ...(igCustomHeaders.trim() ? { customHeaders: igCustomHeaders } : {}),
                  }
                : null;
              onSave(llmCfg, igCfg);
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
