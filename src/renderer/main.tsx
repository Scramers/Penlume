import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LocalizationProvider } from './localization'
import './styles.css'
import './workspace.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing application root element.')

createRoot(root).render(<LocalizationProvider><App /></LocalizationProvider>)
