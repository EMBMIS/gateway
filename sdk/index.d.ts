interface SAGConfig {
    /** Agent name (must be registered in SAG) */
    agent: string;
    /** Agent API key */
    key: string;
    /** SAG Gateway URL (default: http://localhost:3000) */
    endpoint?: string;
    /** Request timeout in ms (default: 5000) */
    timeout?: number;
    /** If true, allow on SAG unreachable (default: false) */
    failOpen?: boolean;
    /** Callback fired on every decision */
    onDecision?: (result: SAGResult) => void;
}

interface SAGResult {
    allowed: boolean;
    blocked: boolean;
    status: 'APPROVED' | 'DENIED' | 'ESCALATED' | 'ERROR' | 'FAIL_OPEN';
    tool: string;
    action: string;
    reason: string | null;
    riskScore: number | null;
    traceId: string | null;
    policyMatch: string | null;
    executionResult: any;
    latencyMs: number | null;
    raw: any;
}

interface SAGCheckResult {
    allowed: boolean;
    risk: number;
    reason: string;
    raw: any;
}

interface SAGClient {
    /** Execute a tool call through the SAG enforcement layer */
    execute(tool: string, args?: Record<string, any>, opts?: { action?: string; resource?: Record<string, any> }): Promise<SAGResult>;
    /** Dry-run policy check without execution */
    check(tool: string, args?: Record<string, any>): Promise<SAGCheckResult>;
    /** Get recent audit entries */
    history(limit?: number): Promise<any[]>;
}

declare function createClient(config: SAGConfig): SAGClient;

export = createClient;
export { createClient, SAGConfig, SAGClient, SAGResult, SAGCheckResult };
