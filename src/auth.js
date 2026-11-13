/**
 * SAG — Authentication Module
 * 
 * Handles user registration, login, session management.
 * Passwords: bcrypt (cost 12).
 * Sessions: HttpOnly + Secure + SameSite=Strict cookies.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, uuidv4 } = require('./database');

const BCRYPT_COST = 12;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Rate limiter (simple in-memory) ───
const registerAttempts = new Map();
const RATE_LIMIT_WINDOW = 60_000;  // 1 minute
const MAX_REGISTER_PER_WINDOW = 5;

function isRateLimited(ip) {
    const now = Date.now();
    const entry = registerAttempts.get(ip);
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
        registerAttempts.set(ip, { windowStart: now, count: 1 });
        return false;
    }
    entry.count++;
    return entry.count > MAX_REGISTER_PER_WINDOW;
}

/**
 * Register a new user and create their workspace.
 */
async function registerUser(email, password) {
    if (!email || !EMAIL_RE.test(email)) {
        return { error: 'Invalid email format', code: 400 };
    }
    if (!password || password.length < 8) {
        return { error: 'Password must be at least 8 characters', code: 400 };
    }

    const db = getDb();

    // Check if user exists
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) {
        return { error: 'An account with this email already exists', code: 409 };
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const userId = uuidv4();
    const projectId = 'proj_' + crypto.randomBytes(12).toString('hex');

    // Create the workspace (project) for this user
    const rawApiKey = 'sag_live_' + crypto.randomBytes(24).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

    db.prepare('INSERT INTO projects (id, name, api_key_hash) VALUES (?, ?, ?)')
        .run(projectId, `${email.split('@')[0]}'s Workspace`, apiKeyHash);

    // Create user
    db.prepare('INSERT INTO users (id, email, password_hash, project_id, role) VALUES (?, ?, ?, ?, ?)')
        .run(userId, email.toLowerCase(), passwordHash, projectId, 'admin');

    console.log(`[AUTH] New user registered: ${email} → workspace ${projectId}`);

    return {
        success: true,
        user: { id: userId, email: email.toLowerCase(), projectId, role: 'admin' },
        apiKey: rawApiKey
    };
}

/**
 * Authenticate a user and create a session.
 */
async function loginUser(email, password) {
    if (!email || !password) {
        return { error: 'Email and password are required', code: 400 };
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

    if (!user) {
        return { error: 'Invalid email or password', code: 401 };
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
        return { error: 'Invalid email or password', code: 401 };
    }

    // Create session
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .run(sessionId, user.id, expiresAt);

    console.log(`[AUTH] User logged in: ${email}`);

    return {
        success: true,
        sessionId,
        expiresAt,
        user: { id: user.id, email: user.email, projectId: user.project_id, role: user.role }
    };
}

/**
 * Validate a session token and return the user.
 */
function validateSession(sessionId) {
    if (!sessionId) return null;

    const db = getDb();
    const session = db.prepare(`
        SELECT s.*, u.email, u.project_id, u.role 
        FROM sessions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.id = ? AND s.expires_at > datetime('now')
    `).get(sessionId);

    if (!session) return null;

    return {
        id: session.user_id,
        email: session.email,
        projectId: session.project_id,
        role: session.role
    };
}

/**
 * Destroy a session (logout).
 */
function destroySession(sessionId) {
    if (!sessionId) return;
    const db = getDb();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * Express middleware: require authentication for dashboard routes.
 * Attaches req.user = { id, email, projectId, role }
 */
function requireAuth(req, res, next) {
    const sessionId = req.cookies?.sag_session;
    const user = validateSession(sessionId);

    if (!user) {
        return res.status(401).json({ error: 'Authentication required', redirect: '/login.html' });
    }

    req.user = user;
    next();
}

/**
 * Cookie options for session tokens.
 */
function getSessionCookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: SESSION_DURATION_MS,
        // Under a shared host the cookie belongs to the gateway's path only (SAG_BASE_PATH, e.g. /gateway).
        path: (process.env.SAG_BASE_PATH || '').replace(/\/+$/, '') || '/'
    };
}

module.exports = {
    registerUser,
    loginUser,
    validateSession,
    destroySession,
    requireAuth,
    getSessionCookieOptions,
    isRateLimited
};
