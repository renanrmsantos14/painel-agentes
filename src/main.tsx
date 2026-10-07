// O bundle do Design System lê o React de window.React: react-global vem antes de tudo.
import './react-global'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './vendor/betinhos-tokens.css'
import './vendor/betinhos-ui.css'

createRoot(document.getElementById('root')!).render(<App />)
