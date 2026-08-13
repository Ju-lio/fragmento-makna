import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/pixel.css';
import './styles/layout.css';
import App from './ui/App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root não existe no index.html');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
