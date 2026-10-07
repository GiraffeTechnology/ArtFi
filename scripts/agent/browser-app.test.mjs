import test from "node:test";
import assert from "node:assert/strict";
import { mountAgentBrowserApp } from "./browser-app.mjs";

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.listeners = {};
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }
}

function fixture() {
  const ownerDocument = {
    createElement(tagName) {
      return new Element(tagName, ownerDocument);
    },
  };
  const root = new Element("main", ownerDocument);
  const values = new Map();
  const revocationStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  return { root, revocationStorage };
}

function walk(node) {
  return [node, ...node.children.flatMap(walk)];
}

function dependencies(revocationStorage) {
  return {
    fetchImpl: async () => {
      throw Error("UNEXPECTED_HTTP_REQUEST");
    },
    basePath: "/api/agent",
    provider: {
      async request() {
        throw Error("UNEXPECTED_WALLET_REQUEST");
      },
    },
    sendRevocation: async () => {
      throw Error("UNEXPECTED_REVOCATION");
    },
    clock: () => 1_750_000_000_000,
    revocationStorage,
  };
}

test("browser composition mounts the concrete ready console without dependency access", () => {
  const { root, revocationStorage } = fixture();
  const app = mountAgentBrowserApp(root, dependencies(revocationStorage));
  const status = walk(root).find((node) => node.attributes.role === "status");
  assert.equal(status.textContent, "接口已接入；尚未读取状态。");
  assert.equal(
    walk(root)
      .filter((node) => node.tagName === "input")
      .every((node) => !node.disabled),
    true,
  );
  app.dispose();
  assert.equal(root.children.length, 0);
});

test("browser composition refuses a non-relative API path before mounting", () => {
  const { root, revocationStorage } = fixture();
  root.append(new Element("sentinel", root.ownerDocument));
  assert.throws(
    () =>
      mountAgentBrowserApp(root, {
        ...dependencies(revocationStorage),
        basePath: "https://example.invalid/api/agent",
      }),
    /HTTP_API_CONFIGURATION_INVALID/,
  );
  assert.equal(root.children[0].tagName, "sentinel");
});

test("browser composition refuses a missing wallet dependency before mounting", () => {
  const { root, revocationStorage } = fixture();
  root.append(new Element("sentinel", root.ownerDocument));
  assert.throws(
    () =>
      mountAgentBrowserApp(root, {
        ...dependencies(revocationStorage),
        provider: undefined,
      }),
    /WALLET_ADAPTER_CONFIGURATION_INVALID/,
  );
  assert.equal(root.children[0].tagName, "sentinel");
});
