'use strict';

/**
 * SAG — Enclave Worker Pool Manager
 *
 * Spawns and supervises N enclave-worker.js processes, one per port
 * starting at ENCLAVE_BASE_PORT (default 50051).
 *
 * Usage:
 *   const pool = require('./worker-pool');
 *   pool.spawn();                   // start all workers
 *   pool.getAddresses();            // ['localhost:50051', 'localhost:50052', ...]
 *   pool.shutdown();                // SIGINT all children
 *
 * Environment variables:
 *   ENCLAVE_POOL_SIZE       Number of workers to spawn (default: 1)
 *   ENCLAVE_BASE_PORT       First port in the range (default: 50051)
 *   WORKER_MAX_RESTARTS     How many times to restart a crashed worker (default: 5)
 *   WORKER_RESTART_DELAY_MS Base delay between restarts in ms (default: 2000, doubles per retry)
 */

const { fork } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

const WORKER_SCRIPT = path.join(__dirname, '..', 'enclave-worker.js');
const POOL_SIZE = Math.max(1, parseInt(process.env.ENCLAVE_POOL_SIZE || '1', 10));
const BASE_PORT = parseInt(process.env.ENCLAVE_BASE_PORT || '50051', 10);
const MAX_RESTARTS = parseInt(process.env.WORKER_MAX_RESTARTS || '5', 10);
const RESTART_DELAY_MS = parseInt(process.env.WORKER_RESTART_DELAY_MS || '2000', 10);

class WorkerPool extends EventEmitter {
    constructor() {
        super();
        /** @type {Array<{process: import('child_process').ChildProcess, port: number, status: string, pid: number|null, restarts: number}>} */
        this.workers = [];
        this._spawned = false;
    }

    /**
     * Spawn all workers. Safe to call once; subsequent calls are no-ops.
     */
    spawn() {
        if (this._spawned) return;
        this._spawned = true;

        if (POOL_SIZE === 0) {
            console.log('[WORKER-POOL] ENCLAVE_POOL_SIZE=0 — no workers spawned. Using external worker.');
            return;
        }

        for (let i = 0; i < POOL_SIZE; i++) {
            this._spawnWorker(BASE_PORT + i, 0);
        }
        console.log(`[WORKER-POOL] Spawned ${POOL_SIZE} enclave worker(s) on ports ${BASE_PORT}..${BASE_PORT + POOL_SIZE - 1}`);
    }

    /** @returns {string[]} gRPC addresses for all workers */
    getAddresses() {
        if (POOL_SIZE === 0) return [];
        const addrs = [];
        for (let i = 0; i < POOL_SIZE; i++) {
            addrs.push(`localhost:${BASE_PORT + i}`);
        }
        return addrs;
    }

    /**
     * Current status of all managed workers.
     * @returns {Array<{port:number,pid:number|null,status:string,restarts:number}>}
     */
    status() {
        return this.workers.map(w => ({
            port: w.port,
            pid: w.pid,
            status: w.status,
            restarts: w.restarts,
        }));
    }

    /** Send SIGINT to all child processes. */
    shutdown() {
        console.log('[WORKER-POOL] Shutting down all enclave workers...');
        for (const w of this.workers) {
            if (w.process && !w.process.killed) {
                try { w.process.kill('SIGINT'); } catch (_) { /* already dead */ }
            }
        }
    }

    // ─── Private ───

    _spawnWorker(port, restartCount) {
        const proc = fork(WORKER_SCRIPT, [], {
            env: { ...process.env, ENCLAVE_PORT: String(port) },
            // inherit stdio so worker logs appear in the same terminal
            stdio: 'inherit',
        });

        const entry = {
            process: proc,
            port,
            status: 'starting',
            pid: null,
            restarts: restartCount,
        };

        // Replace any existing entry for this port (restart scenario)
        const idx = this.workers.findIndex(w => w.port === port);
        if (idx >= 0) {
            this.workers[idx] = entry;
        } else {
            this.workers.push(entry);
        }

        proc.once('spawn', () => {
            entry.status = 'running';
            entry.pid = proc.pid;
            console.log(`[WORKER-POOL] Worker :${port} started (PID ${proc.pid})`);
            this.emit('worker:up', { port, pid: proc.pid });
        });

        proc.once('exit', (code, signal) => {
            entry.status = 'exited';
            entry.pid = null;
            const reason = signal ? `signal ${signal}` : `code ${code}`;
            console.warn(`[WORKER-POOL] Worker :${port} exited (${reason}), restarts so far: ${restartCount}`);
            this.emit('worker:down', { port, reason });

            // Exponential back-off restart, up to MAX_RESTARTS
            if (restartCount < MAX_RESTARTS) {
                const delay = RESTART_DELAY_MS * Math.pow(2, restartCount);
                console.log(`[WORKER-POOL] Restarting worker :${port} in ${delay}ms (attempt ${restartCount + 1}/${MAX_RESTARTS})`);
                setTimeout(() => this._spawnWorker(port, restartCount + 1), delay);
            } else {
                entry.status = 'failed';
                console.error(`[WORKER-POOL] Worker :${port} exceeded max restarts (${MAX_RESTARTS}). Marking as failed.`);
                this.emit('worker:failed', { port });
            }
        });

        proc.on('error', (err) => {
            entry.status = 'error';
            console.error(`[WORKER-POOL] Worker :${port} process error:`, err.message);
        });

        return entry;
    }
}

module.exports = new WorkerPool();
