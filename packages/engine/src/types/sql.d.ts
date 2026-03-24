/** Allows TypeScript to understand `import sql from '*.sql' with { type: 'text' }` */
declare module '*.sql' {
  const content: string;
  export default content;
}
