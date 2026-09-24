import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { NodeHtmlMarkdown } from "node-html-markdown";
import { checkAddress, isIpLiteral, isLoopbackHost } from "./address.js";

/**
 * Fetch one web page as text for the model (0.2). Security:
 * - Only http(s). http is upgraded to https, except for localhost when allowed.
 * - No user:password in URLs. No cookies, no auth headers, no proxy.
 * - SSRF: every hop's host is resolved once, every address is checked (public unicast only,
 *   loopback only with allowLocalhost), and the connection uses that checked address (no DNS
 *   rebinding between check and use). Redirects are followed by hand, at most 5, each checked;
 *   a redirect to another host asks `onNewHost` first.
 * - Size limits before and after decompression, a time limit, and a content-type allowlist.
 */

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;

export interface FetchOptions {
  signal: AbortSignal;
  allowLocalhost: boolean;
  /** Called before a redirect goes to a different host. false stops the fetch. */
  onNewHost?: (url: URL) => Promise<boolean>;
  /** DNS resolution. Tests replace it. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  maxBytes?: number;
}

export interface Page {
  /** The URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  title?: string;
  /** Markdown for HTML, the text itself for other text types. */
  text: string;
}

export class FetchError extends Error {}

const TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/xml",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
];

/** Check and normalise a URL before any network use. */
export function checkUrl(raw: string, allowLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError(`"${raw.slice(0, 200)}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FetchError(`Only http and https URLs are allowed, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new FetchError("URLs with a user name or password are not allowed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && !(allowLocalhost && isLoopbackHost(host)))
    url.protocol = "https:";
  if (isIpLiteral(host)) {
    const verdict = checkAddress(host, allowLocalhost);
    if (!verdict.ok)
      throw new FetchError(`${host} is a ${verdict.range} address. Garuda does not fetch it.`);
  }
  url.hash = "";
  return url;
}

export async function fetchPage(raw: string, options: FetchOptions): Promise<Page> {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  let url = checkUrl(raw, options.allowLocalhost);
  for (let hop = 0; ; hop++) {
    const response = await get(url, signal, options);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location !== undefined) {
      response.resume();
      if (hop >= MAX_REDIRECTS) throw new FetchError(`More than ${MAX_REDIRECTS} redirects.`);
      const next = checkUrl(new URL(location, url).toString(), options.allowLocalhost);
      if (
        next.host !== url.host &&
        options.onNewHost !== undefined &&
        !(await options.onNewHost(next))
      ) {
        throw new FetchError(`The redirect to ${next.host} was not allowed.`);
      }
      url = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new FetchError(`The server answered ${status} ${response.statusMessage ?? ""}`.trim());
    }
    const contentType = (response.headers["content-type"] ?? "").toLowerCase();
    const mime = contentType.split(";")[0]?.trim() ?? "";
    const isHtml = mime === "text/html";
    if (!isHtml && !TEXT_TYPES.includes(mime) && mime !== "") {
      response.resume();
      throw new FetchError(`Garuda reads only text pages, not ${mime}.`);
    }
    const body = await readBody(response, maxBytes, signal);
    const charset = /charset=([^;]+)/.exec(contentType)?.[1]?.trim().replace(/"/g, "") ?? "utf-8";
    let text: string;
    try {
      text = new TextDecoder(charset).decode(body);
    } catch {
      text = new TextDecoder("utf-8").decode(body);
    }
    if (isHtml) {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
      return {
        url: url.toString(),
        status,
        contentType: mime,
        ...(title ? { title: decodeEntities(title) } : {}),
        text: await htmlToMarkdown(text),
      };
    }
    return { url: url.toString(), status, contentType: mime || "text/plain", text };
  }
}

let markdown: NodeHtmlMarkdown | undefined;
const DROP =
  /<(script|style|noscript|template|iframe|svg|canvas|nav|footer|aside|form|button|select|object|embed)\b[\s\S]*?<\/\1\s*>/gi;

/** HTML to Markdown. The converter loads on first use, not at startup (N3). */
export async function htmlToMarkdown(html: string): Promise<string> {
  if (markdown === undefined) {
    const { NodeHtmlMarkdown } = await import("node-html-markdown");
    markdown = new NodeHtmlMarkdown({ keepDataImages: false, maxConsecutiveNewlines: 2 });
  }
  return markdown.translate(html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP, "")).trim();
}

/** Decode the entities that appear in page titles: named basics and numeric (&#8212; &#x2014;). */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const n =
        code[1] === "x" || code[1] === "X"
          ? Number.parseInt(code.slice(2), 16)
          : Number(code.slice(1));
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

/** One GET, with the checked-address lookup. */
function get(url: URL, signal: AbortSignal, options: FetchOptions): Promise<IncomingMessage> {
  const resolve =
    options.resolve ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new FetchError(`${hostname} has no address.`), "", 4);
          return;
        }
        for (const a of addresses) {
          const verdict = checkAddress(a.address, options.allowLocalhost);
          if (!verdict.ok) {
            const why = `${hostname} resolves to ${a.address}, a ${verdict.range} address. Garuda does not fetch it.`;
            callback(new FetchError(why), "", 4);
            return;
          }
        }
        // The connection uses exactly the addresses that were checked.
        if (lookupOptions.all) {
          callback(
            null,
            addresses.map((a) => ({ address: a.address, family: a.family })),
          );
        } else {
          const first = addresses[0] as { address: string; family: number };
          callback(null, first.address, first.family);
        }
      },
      (error: Error) => callback(error as NodeJS.ErrnoException, "", 4),
    );
  };
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup,
        agent: false,
        signal,
        headers: {
          "user-agent": "Garuda/0.2 (web_fetch; +https://github.com/madhu-sv/garuda)",
          accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      resolvePromise,
    );
    req.on("error", reject);
    req.end();
  });
}

/** Read the body, decompressed, and stop at `maxBytes` (also for compression bombs). */
function readBody(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const encoding = (response.headers["content-encoding"] ?? "").toLowerCase();
  const declared = Number(response.headers["content-length"] ?? "0");
  if (declared > maxBytes) {
    response.destroy();
    return Promise.reject(new FetchError(`The page is too large (${declared} bytes).`));
  }
  const stream: NodeJS.ReadableStream =
    encoding === "gzip" || encoding === "x-gzip"
      ? response.pipe(createGunzip())
      : encoding === "deflate"
        ? response.pipe(createInflate())
        : encoding === "br"
          ? response.pipe(createBrotliDecompress())
          : response;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (error: Error) => {
      response.destroy();
      reject(error);
    };
    signal.addEventListener("abort", () => stop(signal.reason as Error), { once: true });
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop(new FetchError(`The page is larger than ${maxBytes} bytes.`));
      else chunks.push(chunk);
    });
    stream.on("error", (error: Error) =>
      stop(new FetchError(`Could not read the page: ${error.message}`)),
    );
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
