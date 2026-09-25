/**
 * MSW request handlers for Soroban RPC mocking.
 *
 * Handlers dispatch on JSON-RPC method name rather than URL paths,
 * since Soroban RPC uses a single POST endpoint for all methods.
 *
 * Usage:
 * ```ts
 * import { sorobanRpcHandlers } from "@/core/testing/sorobanRpcHandlers";
 * const server = withMswHandlers(...sorobanRpcHandlers());
 * ```
 */

import { http, HttpResponse } from "msw";
import type { JsonRpcResponse } from "@/core/rpc/client";
import { SOROBAN_RPC_URLS } from "@/core/network/config";

export interface SorobanRpcHandlerOptions {
  fixtures?: {
    [methodName: string]: JsonRpcResponse<unknown>;
  };
}

/**
 * Creates MSW handlers for Soroban RPC methods.
 * Handlers match on POST body method name and return appropriate responses.
 */
export function sorobanRpcHandlers(options: SorobanRpcHandlerOptions = {}): ReturnType<typeof http.post>[] {
  const { fixtures = {} } = options;

  const defaultFixtures: Record<string, JsonRpcResponse<unknown>> = {
    simulateTransaction: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        error: null,
        events: [],
        cost: { cpuInsns: "1000", memBytes: "100" },
        latestLedger: 12345
      }
    },
    getLedgerEntries: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        entries: [],
        latestLedger: 12345
      }
    },
    getContractData: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        xdr: "AAAADgAAAAA=",
        latestLedger: 12345
      }
    },
    getNetwork: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        network_passphrase: "Test SDF Network ; September 2015",
        protocol_version: 21
      }
    },
    ...fixtures
  };

  return [
    http.post("*", async ({ request }) => {
      try {
        const body = await request.json() as { method?: string };
        const method = body.method;

        if (!method) {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request" }
          });
        }

        const fixture = defaultFixtures[method];

        if (!fixture) {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            error: { code: -32601, message: `Method not found: ${method}` }
          });
        }

        return HttpResponse.json({
          ...fixture,
          id: (body as Record<string, unknown>).id ?? fixture.id
        });
      } catch {
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        });
      }
    })
  ];
}

/**
 * Creates a handler that responds to a specific Soroban RPC method.
 * Useful for per-test customization.
 */
export function sorobanRpcMethod<T>(
  method: string,
  response: JsonRpcResponse<T>
): ReturnType<typeof http.post> {
  return http.post(Object.values(SOROBAN_RPC_URLS)[0], async ({ request }) => {
    try {
      const body = await request.json() as Record<string, unknown>;
      if (body.method === method) {
        return HttpResponse.json({ ...response, id: body.id ?? response.id });
      }
    } catch {
      // Fall through
    }
    return HttpResponse.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: "Method not found" }
    });
  });
}
