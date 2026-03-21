import type { App } from 'vue';
import type { ZveltioClient } from '@zveltio/sdk';

export const ZVELTIO_CLIENT_KEY = 'zveltio-client';

export interface ZveltioPluginOptions {
  client: ZveltioClient;
}

export const ZveltioPlugin = {
  install(app: App, options: ZveltioPluginOptions) {
    if (!options?.client) {
      throw new Error('[ZveltioPlugin] options.client is required');
    }
    app.provide(ZVELTIO_CLIENT_KEY, options.client);
  },
};
