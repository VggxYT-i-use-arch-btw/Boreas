declare global {
  interface GlobalThis {
    BoreasRefreshAccountScopedState?: () => void;
    BoreasSessionContextStale?: boolean;
    BoreasLoadMoreChats?: () => Promise<void>;
    BoreasChatsHasMore?: () => boolean;
  }
  var BOREAS_BACKEND_URL: string | undefined;
  var BOREAS_LOGO_URL: string;
  var BACKEND_URL: string;
  var BoreasApi: typeof import("../api/client");
  var BoreasSessionHeaders: (extra?: Record<string, string>) => Record<string, string>;
  var BoreasFetchWithTimeout: (input: RequestInfo | URL, options?: RequestInit, timeoutMs?: number) => Promise<Response>;
  var BoreasClearSyncQueue: (() => Promise<void>) | undefined;
  var BoreasClearImageStore: ((scope: string) => Promise<void>) | undefined;
  var BoreasClearAllImageStore: (() => Promise<void>) | undefined;
  var BoreasClearLegacyImageStore: (() => Promise<void>) | undefined;
  var BoreasClearScopedCache: ((scope: string) => void) | undefined;
  var BoreasClearAllScopedCaches: (() => void) | undefined;
  var BoreasClearPendingGenerations: (() => void) | undefined;
  var BoreasSetAuthScope: ((scope: string | null) => Promise<void>) | undefined;
  var BoreasRefreshAccountScopedState: (() => void) | undefined;
}

export {};
