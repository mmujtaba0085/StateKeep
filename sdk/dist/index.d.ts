export declare class StateKeepError extends Error {
    readonly status: number;
    readonly code: string;
    readonly body: unknown;
    constructor(message: string, status: number, code: string, body?: unknown);
}
export interface Actor {
    actorId: string;
    definitionId: string;
    machineId?: string;
    stateValue: string | Record<string, unknown>;
    context: Record<string, unknown>;
    status: 'active' | 'migrating' | 'needs_rescue' | 'terminated' | 'archived';
    historyFingerprint: string;
    logicalStartTick: number;
    done: boolean;
    migratedTo?: string;
    idempotent?: boolean;
}
export interface DeployResult {
    id: string;
    parentId: string | null;
    deployedAt: number;
    deploymentId: string | null;
    affectedActors: number;
    idempotent: boolean;
    engineAvailable: boolean;
    warnings: Warning[];
}
export interface ConfirmationRequired {
    status: 'requires_confirmation';
    confirmToken: string;
    strandedActors: Array<{
        currentState: string;
        atVersion?: string;
        reason?: string;
        count: number;
    }>;
    safeActors: number;
    expiresIn: number;
    warnings: Warning[];
    message?: string;
    /** Why a fresh preview was returned instead of deploying (expired/used token, changed definition, new strandings). */
    reason?: string;
    /** How many actors would now be stranded that were not in the previous preview. */
    notInPreview?: number;
}
/** A transition in a history pattern: an event type, or a delayed transition by state path and delay. */
export type HistoryStep = string | {
    after: string;
    ms: number;
};
/** contextTransform entry: copy from a path, set a constant, or copy with a default. */
export type ContextTransformSpec = string | {
    value: unknown;
} | {
    from: string;
    default?: unknown;
};
export interface Warning {
    type: string;
    severity: string;
    message: string;
}
export interface PreviewResult {
    wouldDeploy: boolean;
    warnings: Warning[];
    strandedActors: Array<{
        currentState: string;
        count: number;
    }>;
    migration: {
        eligible: number;
        wouldMigrate: Array<{
            actorId: string;
            currentState: string;
            targetDefinitionId: string;
        }>;
        wouldStay: Array<{
            actorId: string;
            currentState: string;
            reason: string;
        }>;
        engineAvailable: boolean;
    };
}
export interface ActorEvent {
    id: number;
    type: string;
    payload: Record<string, unknown> | null;
    tick: number;
    processedAt: number;
}
export interface EventsResult {
    events: ActorEvent[];
    count: number;
    hasMore: boolean;
    nextCursor: number | null;
}
export interface ScheduledEvent {
    id: string;
    actorId: string;
    eventType: string;
    fireAt: number;
    status: 'pending' | 'fired' | 'failed' | 'cancelled';
}
export interface ValidationResult {
    valid: boolean;
    initialState: string;
    stateCount: number;
    states: string[];
    finalStates: string[];
    errors: Warning[];
    warnings: Warning[];
}
export interface StateKeepConfig {
    baseUrl: string;
    apiKey: string;
}
export interface DeployOptions {
    parentId?: string;
    /** Route only actors whose whole transition history equals this sequence. Omit for every actor. */
    historyPath?: HistoryStep[];
    /** Parallel machines: route by the histories of these regions (mutually exclusive with historyPath). */
    historyRegions?: Record<string, HistoryStep[]>;
    /** { "old.leaf.path": "new.leaf.path" } for removed or renamed states. */
    stateMapping?: Record<string, string>;
    contextTransform?: Record<string, ContextTransformSpec>;
    /** Token from a requires_confirmation response, to accept the listed strandings. */
    confirmToken?: string;
}
export declare class StateKeepClient {
    private readonly base;
    private readonly key;
    constructor(config: StateKeepConfig);
    private headers;
    private req;
    validate(definition: object): Promise<ValidationResult>;
    deploy(id: string, definition: object, options?: DeployOptions): Promise<DeployResult>;
    preview(id: string, definition: object, options?: Omit<DeployOptions, 'confirmToken'>): Promise<PreviewResult>;
    getDefinition(id: string): Promise<object>;
    getDefinitionStatus(id: string): Promise<object>;
    getDefinitionDiff(id: string): Promise<object>;
    getDefinitionStats(id: string): Promise<object>;
    getMachineStats(machineId: string): Promise<object>;
    listDefinitions(opts?: {
        limit?: number;
        offset?: number;
    }): Promise<object>;
    spawn(definitionId: string, initialContext?: Record<string, unknown>): Promise<Actor>;
    send(actorId: string, eventType: string, payload?: Record<string, unknown>, idempotencyKey?: string): Promise<Actor>;
    getState(actorId: string): Promise<Actor>;
    getEvents(actorId: string, opts?: {
        limit?: number;
        after?: number;
    }): Promise<EventsResult>;
    getDecisions(actorId: string): Promise<object>;
    exportActor(actorId: string): Promise<object>;
    terminate(actorId: string): Promise<void>;
    rescueActor(actorId: string): Promise<Actor>;
    listActors(opts?: {
        status?: string;
        machineId?: string;
        state?: string;
        limit?: number;
        offset?: number;
    }): Promise<{
        actors: Actor[];
        count: number;
    }>;
    listNeedsRescue(opts?: {
        definitionId?: string;
        limit?: number;
        offset?: number;
    }): Promise<{
        actors: Actor[];
        count: number;
    }>;
    schedule(actorId: string, eventType: string, opts: {
        delay?: number;
        fireAt?: number;
        payload?: Record<string, unknown>;
    }): Promise<ScheduledEvent>;
    listScheduled(actorId: string, opts?: {
        status?: string;
    }): Promise<{
        scheduled: ScheduledEvent[];
        count: number;
    }>;
    cancelScheduled(actorId: string, scheduleId: string): Promise<void>;
    createWebhook(opts: {
        url: string;
        secret: string;
        events: string[];
    }): Promise<object>;
    listWebhooks(): Promise<object>;
    deleteWebhook(webhookId: string): Promise<void>;
    health(): Promise<{
        status: string;
    }>;
    workerHealth(): Promise<object>;
}
export declare function createClient(config: StateKeepConfig): StateKeepClient;
//# sourceMappingURL=index.d.ts.map