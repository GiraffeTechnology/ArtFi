interface ChromeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface ChromeRuntimeMessageSender {
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

declare const chrome: {
  storage: { local: ChromeStorageArea; session: ChromeStorageArea };
  runtime: ChromeRuntime;
};
