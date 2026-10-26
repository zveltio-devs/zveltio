declare global {
  namespace App {
    interface Platform {
      /** The engine's own request handler, set when it renders this app (ADR 0005). */
      engineFetch?: (request: Request) => Promise<Response>;
    }
  }
}

export {};
