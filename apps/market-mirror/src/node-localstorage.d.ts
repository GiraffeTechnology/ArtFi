declare module "node-localstorage" {
  export class LocalStorage {
    constructor(location: string, quota?: number);
    readonly length: number;
    clear(): void;
    getItem(key: string): string | null;
    key(index: number): string | null;
    removeItem(key: string): void;
    setItem(key: string, value: string): void;
  }
}
