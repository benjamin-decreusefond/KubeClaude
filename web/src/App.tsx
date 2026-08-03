import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, getToken, setToken } from './api';
import { usePolled, useTheme } from './hooks';
import { Agents } from './pages/Agents';
import { Chat } from './pages/Chat';
import { Chats } from './pages/Chats';
import { Dashboard } from './pages/Dashboard';
import { Errors } from './pages/Errors';
import { GoalDetail } from './pages/GoalDetail';
import { Goals } from './pages/Goals';
import { McpServers } from './pages/McpServers';
import { PromptEditor } from './pages/PromptEditor';
import { Prompts } from './pages/Prompts';
import { RunDetail } from './pages/RunDetail';
import { Runs } from './pages/Runs';
import { SettingsPage } from './pages/Settings';
import { BrandMark } from './components/BrandMark';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Modal, Field } from './components/primitives';
import type { AuthState } from './types';

export function App({ auth, onAuthChanged }: { auth: AuthState; onAuthChanged: () => void }) {
  const location = useLocation();
  const [theme, setTheme] = useTheme();
  const [showToken, setShowToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(getToken());

  const { data: status, error } = usePolled(() => api.status(), 15_000);
  const queuedPrompts = status?.queuedByKind.scheduled ?? 0;
  const queuedGoals = status?.queuedByKind.goal ?? 0;
  const unauthorized = error?.toLowerCase().includes('unauthorized') ?? false;

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onAuthChanged();
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <BrandMark />
          </div>
          <div>
            <div className="brand-name">KubeClaude</div>
            <div className="brand-sub">Claude Code, on a schedule</div>
          </div>
        </div>

        <nav className="nav">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/chats">Chat</NavLink>
          <NavLink to="/prompts">
            Prompts
            {/* Only what this page can actually show: a goal's queued iteration
                belongs to a hidden prompt, and counting it here reads as a list
                that is not loading. */}
            {queuedPrompts > 0 && <span className="nav-count">{queuedPrompts} queued</span>}
          </NavLink>
          <NavLink to="/goals">
            Goals
            {queuedGoals > 0 && <span className="nav-count">{queuedGoals} queued</span>}
          </NavLink>
          <NavLink to="/runs">
            Runs
            {status && (status.activeRuns > 0 || status.queuedRuns > 0) && (
              <span className="nav-count">
                {status.activeRuns > 0 ? `${status.activeRuns} live` : `${status.queuedRuns} queued`}
              </span>
            )}
          </NavLink>
          <NavLink to="/mcp">MCP connections</NavLink>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/errors">
            Errors
            {status && status.errorCount > 0 && <span className="nav-count">{status.errorCount}</span>}
          </NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>

        <div className="sidebar-foot">
          {status && (
            <div>
              {/* Which build is running — the first question after a deploy. */}
              <div title="The image this instance is running">KubeClaude {status.version}</div>
              <div>Claude CLI {status.claudeVersion ?? 'not found'}</div>
              <div>
                {status.activeRuns}/{status.maxConcurrentRuns} running
                {status.awaitingResume > 0 && ` · ${status.awaitingResume} awaiting quota`}
              </div>
            </div>
          )}
          <div>
            {auth.method === 'none' ? (
              <span className="stat-note">No authentication</span>
            ) : (
              <span className="stat-note">
                {auth.username ? `Signed in as ${auth.username}` : 'Signed in'}
                {auth.via === 'local' ? ' (local network)' : auth.via === 'proxy' ? ' (via proxy)' : ''}
              </span>
            )}
          </div>
          <div className="row">
            <select
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
              aria-label="Theme"
              style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            {auth.via === 'session' ? (
              <button className="ghost small" onClick={() => void signOut()}>
                Sign out
              </button>
            ) : (
              <button className="ghost small" onClick={() => setShowToken(true)}>
                API key
              </button>
            )}
          </div>
        </div>
      </aside>

      <main className="main">
        {unauthorized && (
          <div className="banner critical">
            <span className="banner-icon" aria-hidden>
              !
            </span>
            <div>
              Your session is no longer valid.{' '}
              <button className="ghost small" onClick={onAuthChanged}>
                Sign in again
              </button>
            </div>
          </div>
        )}

        {/* Keyed on the path, so a page that threw does not stay broken once you navigate away. */}
        <ErrorBoundary key={location.pathname} where={location.pathname}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/chats" element={<Chats />} />
            <Route path="/chats/:id" element={<Chat />} />
            <Route path="/prompts" element={<Prompts />} />
            <Route path="/prompts/new" element={<PromptEditor />} />
            <Route path="/prompts/:id" element={<PromptEditor />} />
            <Route path="/goals" element={<Goals />} />
            <Route path="/goals/:id" element={<GoalDetail />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/mcp" element={<McpServers />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/errors" element={<Errors />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>

      {showToken && (
        <Modal
          title="API key"
          onClose={() => setShowToken(false)}
          footer={
            <>
              <button className="ghost" onClick={() => setShowToken(false)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => {
                  setToken(tokenDraft.trim());
                  window.location.reload();
                }}
              >
                Save and reload
              </button>
            </>
          }
        >
          <Field
            label="API key or static token"
            hint="Not needed for a normal sign-in — the session cookie handles that. Use it when this browser has to talk to the API as a machine would. Stored in this browser only."
          >
            <input
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="Paste the token"
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}
