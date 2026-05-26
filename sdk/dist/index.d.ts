export interface StateKeepConfig {
    baseUrl: string;
    apiKey: string;
    /** Timeout in milliseconds for each request (default: 30000) */
    timeoutMs?: number;
}
export interface Actor {
    id: string;
    definitionId: string;
    orgId: string;
    status: 'active' | 'archived' | 'needs_rescue';
    currentState: string;
    context: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}
export interface ActorEvent {
    id: number;
    actorId: string;
    eventType: string;
    eventPayload: Record<string, unknown> | null;
    tick: number;
    processedAt: string;
}
export interface SpawnActorOptions {
    definitionId: string;
    initialContext?: Record<string, unknown>;
    id?: string;
}
export interface SendEventOptions {
    type: string;
    payload?: Record<string, unknown>;
}
export interface ListActorEventsOptions {
    limit?: number;
    afterId?: number;
}
export interface ListActorEventsResult {
    actorId: string;
    events: ActorEvent[];
    limit: number;
    afterId: number;
    nextCursor: number | null;
}
export interface BulkSpawnOptions {
    actors: Array<{
        definitionId: string;
        initialContext?: Record<string, unknown>;
    }>;
}
export interface BulkSpawnResult {
    created: Actor[];
    failed: Array<{
        input: unknown;
        error: string;
    }>;
    total: number;
}
export interface StateMachineDefinition {
    id: string;
    orgId: string;
    parentId: string | null;
    machineDefinition: Record<string, unknown>;
    stateMapping?: Record<string, string>;
    historyRegions?: string[];
    createdAt: string;
}
export interface DeployDefinitionOptions {
    id: string;
    parentId?: string;
    machineDefinition: Record<string, unknown>;
    stateMapping?: Record<string, string>;
    historyRegions?: string[];
}
export interface Webhook {
    id: string;
    orgId: string;
    url: string;
    events: string[];
    active: boolean;
    secret: string | null;
    createdAt: string;
}
export interface CreateWebhookOptions {
    url: string;
    events: string[];
    secret?: string;
}
export interface UpdateWebhookOptions {
    url?: string;
    events?: string[];
    active?: boolean;
}
export interface ListWebhooksResult {
    webhooks: Webhook[];
    total: number;
}
export interface StateKeepError {
    statusCode: number;
    error: string;
    message: string;
}
export declare class StateKeepRequestError extends Error {
    readonly statusCode: number;
    readonly body: StateKeepError;
    constructor(statusCode: number, body: StateKeepError, message: string);
}
export declare class StateKeepClient {
    private readonly baseUrl;
    private readonly headers;
    private readonly timeoutMs;
    constructor(config: StateKeepConfig);
    private request;
    spawnActor(options: SpawnActorOptions): Promise<Actor>;
    getActor(actorId: string): Promise<Actor>;
    sendEvent(actorId: string, options: SendEventOptions): Promise<Actor>;
    listActorEvents(actorId: string, options?: ListActorEventsOptions): Promise<ListActorEventsResult>;
    bulkSpawnActors(options: BulkSpawnOptions): Promise<BulkSpawnResult>;
    deployDefinition(options: DeployDefinitionOptions): Promise<StateMachineDefinition>;
    getDefinition(definitionId: string): Promise<StateMachineDefinition>;
    listWebhooks(): Promise<ListWebhooksResult>;
    getWebhook(webhookId: string): Promise<Webhook>;
    createWebhook(options: CreateWebhookOptions): Promise<Webhook>;
    updateWebhook(webhookId: string, options: UpdateWebhookOptions): Promise<Webhook>;
    deleteWebhook(webhookId: string): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map