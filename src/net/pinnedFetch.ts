import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { checkAddress, isIpLiteral } from "./address.js";

/**
 * A `fetch` that connects only to public addresses (0.4), for remote MCP servers that a project
 * defines. Each request resolves the host once, checks every address (public unicast only), and
 * connects to that checked address: no DNS rebinding between the check and the use. It follows no
 * redirects (a 3xx goes back to the caller), sends no cookies and uses no proxy.
 *
 * Responses stream (Streamable HTTP uses server-sent events), so the body is not buffered.
 */

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export class BlockedAddressError extends Error {}

const defaultResolve: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

export function pinnedFetch(options: { resolve?: Resolver } = {}): typeof fetch {
  const resolve = options.resolve ?? defaultResolve;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new BlockedAddressError(`Only http and https, not ${url.protocol}`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIpLiteral(host)
      ? [{ address: host, family: host.includes(":") ? 6 : 4 }]
      : await resolve(host);
    if (addresses.length === 0) throw new BlockedAddressError(`${host} has no address.`);
    for (const a of addresses) {
      const verdict = checkAddress(a.address, false);
      if (!verdict.ok) {
        throw new BlockedAddressError(
          `${host} resolves to a ${verdict.range} address (${a.address}). A project's MCP server must be public.`,
        );
      }
    }
    const pinned = addresses[0] as { address: string; family: number };
    const lookup: LookupFunction = (_host, opts, callback) => {
      if (opts.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = await bodyBytes(
      init.body ?? (input instanceof Request ? await input.arrayBuffer() : undefined),
    );
    if (init.body instanceof URLSearchParams && !headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
    if (body !== undefined) headers.set("content-length", String(body.byteLength));
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const signal = init.signal ?? undefined;
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<Response>((resolvePromise, reject) => {
      const req = request(
        url,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          lookup,
          ...(url.protocol === "https:"
            ? { servername: isIpLiteral(host) ? undefined : host }
            : {}),
          ...(signal === undefined || signal === null ? {} : { signal }),
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
          }
          const empty = status === 204 || status === 304 || method === "HEAD";
          if (empty) res.resume();
          resolvePromise(
            new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
              status,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }) as typeof fetch;
}

async function bodyBytes(body: unknown): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  return new Uint8Array(
    await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer(),
  );
}
