import React, { createContext, useContext, useEffect, useRef } from 'react';
import type { ZveltioClient } from '@zveltio/sdk';

const ZveltioContext = createContext<ZveltioClient | null>(null);

export interface ZveltioProviderProps {
  client: ZveltioClient;
  children: React.ReactNode;
}

export function ZveltioProvider({ client, children }: ZveltioProviderProps) {
  return (
    <ZveltioContext.Provider value={client}>
      {children}
    </ZveltioContext.Provider>
  );
}

export function useZveltioClient(): ZveltioClient {
  const client = useContext(ZveltioContext);
  if (!client) {
    throw new Error('useZveltioClient must be used within a ZveltioProvider');
  }
  return client;
}
