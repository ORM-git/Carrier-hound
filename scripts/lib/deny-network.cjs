/**
 * scripts/lib/deny-network.cjs
 *
 * Preload isolation guard for child test processes.
 * Preloaded via NODE_OPTIONS="--require .../deny-network.cjs" before any suite imports.
 *
 * Enforces:
 * - Denial of external network access (fetch, http, https, net sockets, tls)
 * - Explicit loopback allowance only: localhost, 127.0.0.1, ::1, 0.0.0.0, [::1], [::]
 * - Denial of remote redirects from local endpoints to external destinations
 * - Child-process containment: propagates network denial to spawned children and blocks network CLI binaries
 *
 * KNOWN UNGUARDED TRANSPORT LIMITATIONS:
 * 1. Native C++ Addons: Precompiled native addons (.node binaries) that call OS socket
 *    syscalls directly (e.g. via winsock / libc socket()) bypass Node.js JS hooks.
 * 2. WebAssembly WASI Sockets: WebAssembly binaries executing with direct WASI host imports.
 * 3. Raw OS Syscalls: Out-of-band system utilities not invoked through child_process.
 */

"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const path = require("path");
const cp = require("child_process");

const THIS_SCRIPT_PATH = path.resolve(__filename).replace(/\\/g, "/");

// Blocked network utilities
const BLOCKED_BINARIES = Object.freeze(["curl", "wget", "nc", "ncat", "telnet"]);

/**
 * Checks if a hostname or IP string represents an authorized loopback address.
 */
function isLoopbackHost(hostname) {
  if (!hostname) {
    return true; // IPC or local socket
  }
  const clean = String(hostname).toLowerCase().trim().replace(/^\[|\]$/g, "");
  return (
    clean === "localhost" ||
    clean === "127.0.0.1" ||
    clean === "::1" ||
    clean === "0.0.0.0" ||
    clean === "::" ||
    clean.endsWith(".localhost")
  );
}

/**
 * Extracts hostname from an HTTP/HTTPS options argument or URL.
 */
function extractHostFromOptions(optionsOrUrl) {
  if (typeof optionsOrUrl === "string") {
    try {
      const parsed = new URL(optionsOrUrl, "http://localhost");
      return parsed.hostname;
    } catch {
      return optionsOrUrl.split(":")[0];
    }
  }
  if (optionsOrUrl && typeof optionsOrUrl === "object") {
    if (optionsOrUrl.hostname) {
      return optionsOrUrl.hostname;
    }
    if (optionsOrUrl.host) {
      return String(optionsOrUrl.host).split(":")[0];
    }
    if (optionsOrUrl.href) {
      try {
        return new URL(optionsOrUrl.href).hostname;
      } catch {
        // Fall through
      }
    }
  }
  return "localhost";
}

// -----------------------------------------------------------------------------
// 1. Hook http.request & https.request
// -----------------------------------------------------------------------------
function wrapHttpRequest(origFn, protocol) {
  return function interceptedRequest(...args) {
    const host = extractHostFromOptions(args[0]);

    if (!isLoopbackHost(host)) {
      const err = new Error(`[NETWORK DENIED] External ${protocol.toUpperCase()} request blocked to '${host}'`);
      err.code = "ENETWORK_DENIED";
      throw err;
    }

    const clientReq = origFn.apply(this, args);

    // Guard against remote redirect responses
    clientReq.on("response", (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers && res.headers.location) {
        try {
          const redirectUrl = new URL(res.headers.location, `http://${host}`);
          if (!isLoopbackHost(redirectUrl.hostname)) {
            const redirectErr = new Error(
              `[NETWORK DENIED] Remote redirect to '${redirectUrl.hostname}' blocked from local endpoint`
            );
            redirectErr.code = "ENETWORK_DENIED";
            clientReq.destroy(redirectErr);
          }
        } catch {
          // If URL parsing fails, allow standard error handler
        }
      }
    });

    return clientReq;
  };
}

http.request = wrapHttpRequest(http.request, "http");
http.get = function interceptedHttpGet(...args) {
  const req = http.request.apply(this, args);
  req.end();
  return req;
};

https.request = wrapHttpRequest(https.request, "https");
https.get = function interceptedHttpsGet(...args) {
  const req = https.request.apply(this, args);
  req.end();
  return req;
};

// -----------------------------------------------------------------------------
// 2. Hook net.Socket.prototype.connect & net.connect
// -----------------------------------------------------------------------------
function extractHostFromNetArgs(args) {
  let target = args[0];
  if (Array.isArray(target) && target.length > 0) {
    target = target[0];
  }
  let host = "localhost";
  let port = null;

  if (typeof target === "object" && target !== null) {
    if (target.path) {
      return { host: "localhost", isIpc: true };
    }
    host = target.host || target.hostname || "localhost";
    port = target.port;
  } else if (typeof args[0] === "number") {
    port = args[0];
    if (typeof args[1] === "string") {
      host = args[1];
    }
  } else if (typeof args[0] === "string" && isNaN(Number(args[0]))) {
    return { host: "localhost", isIpc: true };
  }
  return { host, port, isIpc: false };
}

const origSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function interceptedSocketConnect(...args) {
  const { host, port, isIpc } = extractHostFromNetArgs(args);

  if (isIpc) {
    return origSocketConnect.apply(this, args);
  }

  if (!isLoopbackHost(host)) {
    const err = new Error(`[NETWORK DENIED] External TCP socket connection blocked to '${host}:${port || "unknown"}'`);
    err.code = "ENETWORK_DENIED";
    process.nextTick(() => {
      this.destroy(err);
      this.emit("error", err);
    });
    return this;
  }

  return origSocketConnect.apply(this, args);
};

// -----------------------------------------------------------------------------
// 3. Hook tls.connect
// -----------------------------------------------------------------------------
const origTlsConnect = tls.connect;
tls.connect = function interceptedTlsConnect(...args) {
  const { host, port, isIpc } = extractHostFromNetArgs(args);

  if (isIpc) {
    return origTlsConnect.apply(this, args);
  }

  if (!isLoopbackHost(host)) {
    const err = new Error(`[NETWORK DENIED] External TLS connection blocked to '${host}'`);
    err.code = "ENETWORK_DENIED";
    const dummy = new net.Socket();
    process.nextTick(() => {
      dummy.destroy(err);
      dummy.emit("error", err);
    });
    return dummy;
  }

  return origTlsConnect.apply(this, args);
};

// -----------------------------------------------------------------------------
// 4. Hook globalThis.fetch
// -----------------------------------------------------------------------------
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(resource, init) {
    let host = "localhost";
    try {
      const urlStr = typeof resource === "string" ? resource : (resource && resource.url) || String(resource);
      const parsed = new URL(urlStr, "http://localhost");
      host = parsed.hostname;
    } catch {
      host = "unknown";
    }

    if (!isLoopbackHost(host)) {
      const err = new Error(`[NETWORK DENIED] External fetch blocked to '${host}'`);
      err.code = "ENETWORK_DENIED";
      throw err;
    }

    const res = await origFetch.call(this, resource, init);

    // Reject remote redirects
    if (res.redirected) {
      try {
        const finalHost = new URL(res.url).hostname;
        if (!isLoopbackHost(finalHost)) {
          const redirectErr = new Error(`[NETWORK DENIED] Remote redirect to '${finalHost}' blocked`);
          redirectErr.code = "ENETWORK_DENIED";
          throw redirectErr;
        }
      } catch (e) {
        if (e && e.code === "ENETWORK_DENIED") throw e;
      }
    }

    if (res.status >= 300 && res.status < 400 && res.headers) {
      const loc = res.headers.get("location");
      if (loc) {
        try {
          const locHost = new URL(loc, res.url || "http://localhost").hostname;
          if (!isLoopbackHost(locHost)) {
            const redirectErr = new Error(`[NETWORK DENIED] Remote redirect location '${locHost}' blocked`);
            redirectErr.code = "ENETWORK_DENIED";
            throw redirectErr;
          }
        } catch (e) {
          if (e && e.code === "ENETWORK_DENIED") throw e;
        }
      }
    }

    return res;
  };
}

// -----------------------------------------------------------------------------
// 5. Child process containment: propagate preload and deny network tools
// -----------------------------------------------------------------------------
function checkCommandSafety(commandOrFile) {
  if (typeof commandOrFile !== "string") return;
  const base = path.basename(commandOrFile).toLowerCase().replace(/\.exe$/, "");
  if (BLOCKED_BINARIES.includes(base)) {
    const err = new Error(`[NETWORK DENIED] External network utility '${base}' execution blocked`);
    err.code = "ENETWORK_DENIED";
    throw err;
  }
}

function enforceChildEnv(options) {
  const opts = options || {};
  opts.env = opts.env || { ...process.env };
  const requireArg = `--require "${THIS_SCRIPT_PATH}"`;
  if (!opts.env.NODE_OPTIONS || !opts.env.NODE_OPTIONS.includes("deny-network.cjs")) {
    opts.env.NODE_OPTIONS = opts.env.NODE_OPTIONS ? `${requireArg} ${opts.env.NODE_OPTIONS}` : requireArg;
  }
  return opts;
}

const origSpawn = cp.spawn;
cp.spawn = function interceptedSpawn(command, args, options) {
  checkCommandSafety(command);
  const actualOpts = typeof args === "object" && !Array.isArray(args) ? args : options;
  enforceChildEnv(actualOpts);
  return origSpawn.apply(this, arguments);
};

const origSpawnSync = cp.spawnSync;
cp.spawnSync = function interceptedSpawnSync(command, args, options) {
  checkCommandSafety(command);
  const actualOpts = typeof args === "object" && !Array.isArray(args) ? args : options;
  enforceChildEnv(actualOpts);
  return origSpawnSync.apply(this, arguments);
};

const origExec = cp.exec;
cp.exec = function interceptedExec(command, options, callback) {
  checkCommandSafety(command.split(/\s+/)[0]);
  const actualOpts = typeof options === "function" ? {} : options;
  enforceChildEnv(actualOpts);
  return origExec.apply(this, arguments);
};

const origExecSync = cp.execSync;
cp.execSync = function interceptedExecSync(command, options) {
  checkCommandSafety(command.split(/\s+/)[0]);
  enforceChildEnv(options);
  return origExecSync.apply(this, arguments);
};

module.exports = {
  isLoopbackHost,
  extractHostFromOptions,
};
