/// <reference types="vite/client" />

/** Fontes entram como URL (o Vite resolve o asset); ver engine/fonts.ts. */
declare module '*.ttf' {
  const url: string;
  export default url;
}
