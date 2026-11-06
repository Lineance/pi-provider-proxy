import { describe, expect, it } from "vitest";

import { buildProviderIndex, knownProviders } from "../src/core/providers.js";

describe("buildProviderIndex", () => {
  it("maps model baseUrls onto provider ids", () => {
    const index = buildProviderIndex([
      { provider: "provider-a", baseUrl: "https://api.example.com" },
      { provider: "provider-a", baseUrl: "https://API.Example.COM/v1" },
      { provider: "provider-b", baseUrl: "https://api.example.net/inference/go/openai/v1" },
      { provider: "local-gateway", baseUrl: "http://127.0.0.1:8899/v1" },
    ]);

    expect(index.hostToProviders.get("api.example.com")).toEqual(["provider-a"]);
    expect(index.hostToProviders.get("api.example.net")).toEqual(["provider-b"]);
    expect(index.hostToProviders.get("127.0.0.1")).toEqual(["local-gateway"]);
    expect(index.providerHosts.get("provider-a")).toEqual(["api.example.com"]);
    expect(knownProviders(index)).toEqual(["local-gateway", "provider-a", "provider-b"]);
  });

  it("skips models without provider or baseUrl", () => {
    const index = buildProviderIndex([
      { provider: undefined, baseUrl: "https://a.test" },
      { provider: "x", baseUrl: undefined },
      { provider: "x", baseUrl: "not a url" },
    ]);
    expect(index.hostToProviders.size).toBe(0);
    expect(index.providerHosts.size).toBe(0);
  });

  it("keeps every provider that claims a shared host", () => {
    const index = buildProviderIndex([
      { provider: "a", baseUrl: "https://shared.test/v1" },
      { provider: "b", baseUrl: "https://shared.test/v2" },
    ]);
    expect(index.hostToProviders.get("shared.test")).toEqual(["a", "b"]);
    expect(index.conflicts.get("shared.test")).toEqual(["a", "b"]);
  });

  it("normalizes host case", () => {
    const index = buildProviderIndex([{ provider: "custom", baseUrl: "https://API.Custom.Test" }]);
    expect(index.providerHosts.get("custom")).toEqual(["api.custom.test"]);
  });
});
