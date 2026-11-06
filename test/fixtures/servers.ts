/** Minimal HTTP target + CONNECT proxy used by the integration test. */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

export interface TargetServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** HTTP server that answers every request with `ok:<host header>`. */
export async function startTargetServer(): Promise<TargetServer> {
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain");
    response.end(`ok:${request.headers.host ?? "unknown"}`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface ConnectProxy {
  port: number;
  url: string;
  /** `host:port` of every CONNECT tunnel opened through the proxy. */
  connects: string[];
  close(): Promise<void>;
}

/** TCP proxy that only implements `CONNECT`, recording each tunnel target. */
export async function startConnectProxy(): Promise<ConnectProxy> {
  const connects: string[] = [];
  const sockets = new Set<{ destroy(): void }>();

  const server = http.createServer((_request, response) => {
    response.statusCode = 405;
    response.end("CONNECT only");
  });

  server.on("connect", (request, clientSocket, head) => {
    const target = request.url ?? "";
    connects.push(target);
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));

    const separator = target.lastIndexOf(":");
    const host = target.slice(0, separator);
    const port = Number.parseInt(target.slice(separator + 1), 10);
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    url: `http://127.0.0.1:${String(address.port)}`,
    connects,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
