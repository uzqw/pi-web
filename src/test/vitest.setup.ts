// Node 22.4+ installs globalThis.localStorage/sessionStorage as accessors that
// resolve to undefined unless the process runs with --localstorage-file. Those
// accessors outlive the happy-dom environment, so window.localStorage is missing
// too and every suite that calls localStorage.clear() fails on newer Node
// releases. Restore a working Web Storage wherever the runtime left it broken.

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function isUsable(storage: Storage | undefined): boolean {
  return typeof storage?.clear === "function";
}

if (!isUsable(globalThis.localStorage)) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: createStorage() });
}

if (!isUsable(globalThis.sessionStorage)) {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: createStorage() });
}
