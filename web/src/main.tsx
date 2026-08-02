import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthGate } from './components/AuthGate';
import { installGlobalErrorReporting } from './report';
import './styles.css';

installGlobalErrorReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>{(auth, reload) => <App auth={auth} onAuthChanged={reload} />}</AuthGate>
    </BrowserRouter>
  </StrictMode>,
);
