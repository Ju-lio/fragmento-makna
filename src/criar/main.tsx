import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/pixel.css';
import '../styles/layout.css';
import { Criar } from './Criar.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root não existe no criar.html');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Criar />
  </React.StrictMode>
);
