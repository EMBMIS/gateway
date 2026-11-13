'use strict';

/**
 * sag-mcp-proxy — EMBMIS Gateway MCP proxy server
 *
 * Intercepts every MCP tools/call JSON-RPC request and runs it through
 * EMBMIS Gateway before forwarding to the real upstream MCP server.
 *
 * Usage:
 *   const { SAGMCPProxy } = require('sag-mcp-proxy');
 *   const proxy = new SAGMCPProxy({
 *     upstream:      'http://localhost:3002',   // real MCP server
 *     sagApiKey:     process.env.SAG_API_KEY,
 *     sagGatewayUrl: process.env.SAG_GATEWAY_URL || 'http://localhost:3000',
 *     port:          3001,
 *   });
 *   proxy.listen(3001);
 */

const http = require('http');
const https = require('https');
const url = require('url');

class SAGMCPProxy {
    /**
     * @param {Object} opts
     * @param {string} opts.upstream        - Upstream MCP server base URL
     * @param {string} opts.sagApiKey       - EMBMIS Gateway agent API key (Bearer)
     * @param {string} [opts.sagGatewayUrl] - EMBMIS Gateway base URL (default: http://localhost:3000)
     * @param {number} [opts.port]          - Port to listen on (default: 3001)
     */
    constructor({ upstream, sagApiKey, sagGatewayUrl = 'http://localhost:3000', port = 3001 }) {
        if (!upstream)   throw new Error('SAGMCPProxy: upstream URL is required');
        if (!sagApiKey)  throw new Error('SAGMCPProxy: sagApiKey is required');

        this.upstream      = upstream.replace(/\/$/, '');
        this.sagApiKey     = sagApiKey;
        this.sagGatewayUrl = sagGatewayUrl.replace(/\/$/, '');
        this.port          = port;
        this._server       = null;
    }

    /**
     * Start the proxy HTTP server on the given port.
     * @param {number} [port] - overrides constructor port if provided
     * @returns {http.Server}
     */
    listen(port) {
        if (port) this.port = port;

        this._server = http.createServer((req, res) => {
            this._handleRequest(req, res).catch(err => {
                console.error('[gateway-mcp] Unhandled error:', err.message);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal proxy error' }, id: null }));
                }
            });
        });

        this._server.listen(this.port, () => {
            console.log(`[gateway-mcp] Proxy listening on :${this.port} → upstream ${this.upstream}`);
        });

        return this._server;
    }

    /** Close the proxy server gracefully. */
    close(cb) {
        if (this._server) this._server.close(cb);
    }

    // ─── Internal ──────────────────────────────────────────────────────────

    async _handleRequest(req, res) {
        // Collect body
        const body = await _readBody(req);

        let parsed;
        try { parsed = JSON.parse(body); } catch (_) { parsed = null; }

        const isBatch  = Array.isArray(parsed);
        const requests = isBatch ? parsed : [parsed];

        const results = await Promise.all(
            requests.map(rpc => this._processRpc(rpc, req))
        );

        const responseBody = JSON.stringify(isBatch ? results : results[0]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
    }

    async _processRpc(rpc, incomingReq) {
        if (!rpc || typeof rpc !== 'object') {
            return { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null };
        }

        const { method, params, id } = rpc;

        // Only intercept tools/call — pass everything else through
        if (method !== 'tools/call') {
            return this._forwardToUpstream(rpc, incomingReq);
        }

        // ─── tools/call interception ──────────────────────────────────────
        const tool   = params?.name  || params?.tool  || 'unknown';
        const args   = params?.arguments || params?.args || {};
        const start  = Date.now();

        let sagDecision;
        try {
            sagDecision = await this._checkWithSAG(tool, args);
        } catch (err) {
            console.error(`[gateway-mcp] Gateway check failed for tool=${tool}:`, err.message);
            // Fail-closed: deny on gateway error
            return {
                jsonrpc: '2.0',
                error: { code: -32603, message: 'EMBMIS Gateway: unreachable — request denied for safety', data: { tool } },
                id,
            };
        }

        const latency  = Date.now() - start;
        const decision = sagDecision.decision || sagDecision.status || 'UNKNOWN';
        console.log(`[gateway-mcp] tool=${tool} decision=${decision} latency=${latency}ms`);

        // APPROVED (200)
        if (sagDecision.allowed !== false && !['DENIED', 'deny'].includes(decision)) {
            if (decision === 'ESCALATED') {
                return {
                    jsonrpc: '2.0',
                    error: {
                        code:    -32601,
                        message: 'EMBMIS Gateway: escalated for human review',
                        data:    { decision, traceId: sagDecision.traceId || sagDecision.trace_id },
                    },
                    id,
                };
            }
            // Forward to real MCP server
            return this._forwardToUpstream(rpc, incomingReq);
        }

        // DENIED (403)
        return {
            jsonrpc: '2.0',
            error: {
                code:    -32600,
                message: 'EMBMIS Gateway: tool call denied',
                data:    { decision, reason: sagDecision.reason || sagDecision.message },
            },
            id,
        };
    }

    async _checkWithSAG(tool, args) {
        const gatewayUrl = `${this.sagGatewayUrl}/api/gateway/execute`;
        const payload = JSON.stringify({ tool, action: 'EXECUTE', args });

        return new Promise((resolve, reject) => {
            const parsed   = url.parse(gatewayUrl);
            const isHttps  = parsed.protocol === 'https:';
            const lib      = isHttps ? https : http;
            const options  = {
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     parsed.path,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'Authorization':  `Bearer ${this.sagApiKey}`,
                },
            };

            const req = lib.request(options, res => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const body = JSON.parse(data);
                        // Normalise: HTTP 200 = approved, 403 = denied, 202 = escalated
                        if (res.statusCode === 403) body.allowed = false;
                        else if (res.statusCode === 202) body.decision = body.decision || 'ESCALATED';
                        else body.allowed = body.allowed !== false;
                        resolve(body);
                    } catch(e) {
                        reject(new Error('Invalid JSON from EMBMIS Gateway'));
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(new Error('EMBMIS Gateway timeout')); });
            req.write(payload);
            req.end();
        });
    }

    async _forwardToUpstream(rpc, incomingReq) {
        const upstreamUrl = `${this.upstream}${incomingReq.url || '/mcp'}`;
        const payload     = JSON.stringify(rpc);

        return new Promise((resolve, reject) => {
            const parsed   = url.parse(upstreamUrl);
            const isHttps  = parsed.protocol === 'https:';
            const lib      = isHttps ? https : http;

            // Forward original headers minus host
            const forwardHeaders = {};
            for (const [k, v] of Object.entries(incomingReq.headers || {})) {
                if (k.toLowerCase() !== 'host' && k.toLowerCase() !== 'content-length') {
                    forwardHeaders[k] = v;
                }
            }
            forwardHeaders['Content-Type']   = 'application/json';
            forwardHeaders['Content-Length'] = Buffer.byteLength(payload);

            const options = {
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     parsed.path,
                method:   'POST',
                headers:  forwardHeaders,
            };

            const req = lib.request(options, res => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try   { resolve(JSON.parse(data)); }
                    catch { reject(new Error('Invalid JSON from upstream MCP server')); }
                });
            });

            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(new Error('Upstream MCP server timeout')); });
            req.write(payload);
            req.end();
        });
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

module.exports = { SAGMCPProxy };
