interface ChromeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface ChromeRuntimeMessageSender {
  /** Set by the browser, not the message. The only trustworthy caller identity available. */
  origin?: string;
}

interface ChromeRuntime {
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: ChromeRuntimeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
}

interface ChromeRegisteredContentScript {
  id: string;
  matches?: string[];
  js?: string[];
  world?: "MAIN" | "ISOLATED";
  runAt?: string;
  allFrames?: boolean;
  persistAcrossSessions?: boolean;
}

interface ChromeScripting {
  registerContentScripts(
    scripts: ChromeRegisteredContentScript[],
  ): Promise<void>;
  unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  getRegisteredContentScripts(): Promise<ChromeRegisteredContentScript[]>;
}

interface ChromePermissions {
  request(request: {
    permissions?: string[];
    origins?: string[];
  }): Promise<boolean>;
  contains(request: {
    permissions?: string[];
    origins?: string[];
  }): Promise<boolean>;
  remove(request: {
    permissions?: string[];
    origins?: string[];
  }): Promise<boolean>;
}

interface ChromeTab {
  url?: string;
}

interface ChromeTabs {
  query(query: {
    active?: boolean;
    currentWindow?: boolean;
  }): Promise<ChromeTab[]>;
}

declare const chrome: {
  storage: { local: ChromeStorageArea; session: ChromeStorageArea };
  runtime: ChromeRuntime;
  scripting: ChromeScripting;
  permissions: ChromePermissions;
  tabs: ChromeTabs;
};
