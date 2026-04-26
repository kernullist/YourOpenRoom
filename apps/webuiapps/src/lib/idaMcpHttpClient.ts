interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface InitializeResultShape {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: {
    name?: string;
    version?: string;
  };
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpHttpClient {
  private readonly endpoint: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private sessionId: string | null = null;
  private protocolVersion = '2025-06-18';
  private requestCounter = 1;
  private initPromise: Promise<void> | null = null;
  private readonly requestTimeoutMs = 5000;

  constructor(endpoint: string, clientName: string, clientVersion: string) {
    this.endpoint = endpoint;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
  }

  async initialize(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initializeInternal();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.initialize();
    const response = await this.sendRequest({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/list',
      params: {},
    });
    const result = (response.result as { tools?: McpToolInfo[] } | undefined) ?? {};
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const response = await this.sendRequest({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    });
    return this.unwrapToolResult(response.result);
  }

  async readResource(uri: string): Promise<unknown> {
    await this.initialize();
    const response = await this.sendRequest({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'resources/read',
      params: { uri },
    });
    return this.unwrapResourceResult(response.result);
  }

  async terminate(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.endpoint, {
        method: 'DELETE',
        headers: {
          'Mcp-Session-Id': this.sessionId,
        },
      });
    } catch {
      // Ignore session cleanup failures.
    } finally {
      this.sessionId = null;
    }
  }

  private nextId(): string {
    const id = `${this.requestCounter}`;
    this.requestCounter += 1;
    return id;
  }

  private async initializeInternal(): Promise<void> {
    const response = await this.sendRequest(
      {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'initialize',
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: {
            name: this.clientName,
            version: this.clientVersion,
          },
        },
      },
      { allowMissingProtocolHeader: true, allowMissingSession: true },
    );

    const result = (response.result as InitializeResultShape | undefined) ?? {};
    if (typeof result.protocolVersion === 'string' && result.protocolVersion.trim()) {
      this.protocolVersion = result.protocolVersion.trim();
    }

    await this.sendNotification('notifications/initialized');
  }

  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const headers = this.buildHeaders(method, params, {
      allowMissingProtocolHeader: false,
      allowMissingSession: false,
    });
    const { controller, timeoutId } = this.createTimeoutController();
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      } satisfies JsonRpcRequest),
    }).finally(() => clearTimeout(timeoutId));

    if (!(response.status === 202 || response.status === 200)) {
      const text = await response.text();
      throw new Error(`MCP notification failed (${response.status}): ${text}`);
    }
  }

  private async sendRequest(
    request: JsonRpcRequest,
    options?: {
      allowMissingProtocolHeader?: boolean;
      allowMissingSession?: boolean;
      retryOnSessionReset?: boolean;
    },
  ): Promise<JsonRpcResponse> {
    const headers = this.buildHeaders(request.method, request.params, {
      allowMissingProtocolHeader: options?.allowMissingProtocolHeader ?? false,
      allowMissingSession: options?.allowMissingSession ?? false,
    });

    const { controller, timeoutId } = this.createTimeoutController();
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(request),
    }).finally(() => clearTimeout(timeoutId));

    const nextSessionId = response.headers.get('mcp-session-id');
    if (nextSessionId) {
      this.sessionId = nextSessionId;
    }

    if (response.status === 404 && this.sessionId && (options?.retryOnSessionReset ?? true)) {
      this.sessionId = null;
      await this.initialize();
      return this.sendRequest(request, {
        allowMissingProtocolHeader: false,
        allowMissingSession: false,
        retryOnSessionReset: false,
      });
    }

    const payload = await this.parseResponseBody(response);
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        (typeof payload === 'object' ? JSON.stringify(payload) : String(payload));
      throw new Error(`MCP HTTP error ${response.status}: ${message}`);
    }

    if (!payload) {
      throw new Error(`MCP request "${request.method}" returned an empty body.`);
    }
    if (payload.error) {
      throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    }
    return payload;
  }

  private buildHeaders(
    method: string,
    params: Record<string, unknown> | undefined,
    options: { allowMissingProtocolHeader: boolean; allowMissingSession: boolean },
  ): HeadersInit {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Method': method,
    };

    if (method === 'tools/call' && typeof params?.name === 'string') {
      headers['Mcp-Name'] = params.name;
    }
    if (method === 'resources/read' && typeof params?.uri === 'string') {
      headers['Mcp-Name'] = params.uri;
    }
    if (this.sessionId && !options.allowMissingSession) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    if (!options.allowMissingProtocolHeader) {
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }
    return headers;
  }

  private createTimeoutController(): { controller: AbortController; timeoutId: ReturnType<typeof setTimeout> } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    return { controller, timeoutId };
  }

  private async parseResponseBody(response: Response): Promise<JsonRpcResponse | null> {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (!text.trim()) return null;

    if (contentType.includes('text/event-stream')) {
      return this.parseSsePayload(text);
    }

    return JSON.parse(text) as JsonRpcResponse;
  }

  private parseSsePayload(text: string): JsonRpcResponse {
    const messages: JsonRpcResponse[] = [];
    let buffer = '';

    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        buffer += `${line.slice(5).trimStart()}\n`;
        continue;
      }
      if (line.trim() === '' && buffer.trim()) {
        messages.push(JSON.parse(buffer.trim()) as JsonRpcResponse);
        buffer = '';
      }
    }

    if (buffer.trim()) {
      messages.push(JSON.parse(buffer.trim()) as JsonRpcResponse);
    }

    const responseMessage = [...messages].reverse().find((message) => message.id !== undefined);
    if (!responseMessage) {
      throw new Error('MCP SSE response did not include a JSON-RPC response message.');
    }
    return responseMessage;
  }

  private unwrapToolResult(result: unknown): unknown {
    const toolResult = (result as {
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    } | null) ?? null;

    if (!toolResult) return null;
    if (toolResult.isError) {
      const message = Array.isArray(toolResult.content)
        ? toolResult.content
            .map((item) => (item.type === 'text' ? item.text || '' : ''))
            .filter(Boolean)
            .join('\n')
        : 'Tool call returned an error.';
      throw new Error(message || 'Tool call returned an error.');
    }
    if (toolResult.structuredContent !== undefined) {
      return toolResult.structuredContent;
    }
    if (!Array.isArray(toolResult.content) || toolResult.content.length === 0) {
      return null;
    }

    const joinedText = toolResult.content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('\n')
      .trim();

    if (!joinedText) return toolResult.content;
    try {
      return JSON.parse(joinedText);
    } catch {
      return joinedText;
    }
  }

  private unwrapResourceResult(result: unknown): unknown {
    const resourceResult = (result as {
      contents?: Array<{
        uri?: string;
        mimeType?: string;
        text?: string;
      }>;
      isError?: boolean;
    } | null) ?? null;

    if (!resourceResult || !Array.isArray(resourceResult.contents) || resourceResult.contents.length === 0) {
      return null;
    }

    const first = resourceResult.contents[0];
    const text = typeof first.text === 'string' ? first.text.trim() : '';
    if (!text) return first;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

const CLIENT_CACHE = new Map<string, McpHttpClient>();

export function getOrCreateMcpHttpClient(endpoint: string): McpHttpClient {
  const normalized = endpoint.trim().replace(/\/+$/, '') || endpoint.trim();
  const existing = CLIENT_CACHE.get(normalized);
  if (existing) return existing;
  const client = new McpHttpClient(normalized, 'openroom-pe-analyst', '0.2.0');
  CLIENT_CACHE.set(normalized, client);
  return client;
}
