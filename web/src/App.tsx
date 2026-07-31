import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getToken, setToken } from './api';
import { usePolled, useTheme } from './hooks';
import { Chat } from './pages/Chat';
import { Chats } from './pages/Chats';
import { Dashboard } from './pages/Dashboard';
import { GoalDetail } from './pages/GoalDetail';
import { Goals } from './pages/Goals';
import { McpServers } from './pages/McpServers';
import { PromptEditor } from './pages/PromptEditor';
import { Prompts } from './pages/Prompts';
import { RunDetail } from './pages/RunDetail';
import { Runs } from './pages/Runs';
import { SettingsPage } from './pages/Settings';
import { Modal, Field } from './components/primitives';

export function App() {
  const [theme, setTheme] = useTheme();
  const [showToken, setShowToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(getToken());

  const { data: status, error } = usePolled(() => api.status(), 15_000);
  const unauthorized = error?.toLowerCase().includes('unauthorized') ?? false;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            KC
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
            {status && <span className="nav-count">{status.queuedRuns > 0 ? `${status.queuedRuns} queued` : ''}</span>}
          </NavLink>
          <NavLink to="/goals">Goals</NavLink>
          <NavLink to="/runs">
            Runs
            {status && status.activeRuns > 0 && <span className="nav-count">{status.activeRuns} live</span>}
          </NavLink>
          <NavLink to="/mcp">MCP connections</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>

        <div className="sidebar-foot">
          {status && (
            <div>
              <div>Claude CLI {status.claudeVersion ?? 'not found'}</div>
              <div>
                {status.activeRuns}/{status.maxConcurrentRuns} running
                {status.awaitingResume > 0 && ` · ${status.awaitingResume} awaiting quota`}
              </div>
            </div>
          )}
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
            <button className="ghost small" onClick={() => setShowToken(true)}>
              API token
            </button>
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
              This KubeClaude requires an API token.{' '}
              <button className="ghost small" onClick={() => setShowToken(true)}>
                Enter it
              </button>
            </div>
          </div>
        )}

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
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {showToken && (
        <Modal
          title="API token"
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
            label="Bearer token"
            hint="Only needed when the server runs with KUBECLAUDE_AUTH_TOKEN set. Stored in this browser only."
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
