# Boreas

Interface web do chat Boreas, feita com TypeScript e Vite.

## Estrutura

- `src/`: aplicação, API, estado, componentes e estilos.
- `public/`: arquivos estáticos servidos sem transformação, incluindo `assets/`.
- `sw.ts`: fonte TypeScript do service worker; Vite gera `dist/sw.js`.
- `.github/workflows/pages.yml`: valida, compila e publica `dist/` no GitHub Pages.

## Desenvolvimento

```sh
npm ci
npm run dev
npm run typecheck
npm run build
```

O site usa o prefixo `/Boreas/` definido em `vite.config.ts`. A URL do backend
é configurada em `src/config/backend.ts`.
