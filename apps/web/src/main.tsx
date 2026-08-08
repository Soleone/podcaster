import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Readiness } from './readiness/Readiness';
import './readiness/readiness.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<StrictMode><Readiness /></StrictMode>);
