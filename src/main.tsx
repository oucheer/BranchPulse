import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { installWebBridge } from './lib/bridge'
import './styles/index.css'

// Must run before the first render: the layout subscribes to scan progress
// unconditionally, and every page calls `window.branchpulse.*`.
installWebBridge()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
)
