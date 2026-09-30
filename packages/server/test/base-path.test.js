import assert from "node:assert/strict";
import test from "node:test";

import {
  FORWARDED_PREFIXES,
  cookieName,
  isHubRequest,
  machineForBasePath,
  machineOrigin,
  pairsHrefForBasePath,
  prefixPath,
  requestBasePath,
} from "../dist/base-path.js";
import { getBasePath, migrateRemoteUrl } from "../static/pairs.js";
import { renderCompactShell } from "../dist/compact/shell.js";
import { nativeSessionUrl, prefixedNativeSessionRedirectTarget } from "../dist/session.js";

const request = (prefix) => ({ headers: prefix === undefined ? {} : { "x-forwarded-prefix": prefix } });

test("Hub route matches /hub pathname regardless of query string or trailing slash", () => {
  assert.equal(isHubRequest("/hub?host=l390"), true);
  assert.equal(isHubRequest("/hub"), true);
  assert.equal(isHubRequest("/hub/"), true);
  assert.equal(isHubRequest("/hub/?host=home"), true);
  assert.equal(isHubRequest("/hub/child?host=l390"), false);
  assert.equal(isHubRequest(undefined), false);
});

test("only the allowlisted forwarded prefixes are accepted", () => {
  assert.deepEqual(FORWARDED_PREFIXES, { sara: "/sara", l390: "/l390", home: "/home" });
  assert.equal(requestBasePath(request("/sara")), "/sara");
  assert.equal(requestBasePath(request("/l390")), "/l390");
  assert.equal(requestBasePath(request("/home")), "/home");
  assert.equal(requestBasePath(request("/evil")), "");
  assert.equal(requestBasePath(request("/sara/x")), "");
  assert.equal(requestBasePath(request()), "");
});

test("prefix helpers preserve legacy paths without a prefix", () => {
  assert.equal(prefixPath("", "/api/pairs"), "/api/pairs");
  assert.equal(prefixPath("/sara", "/api/pairs"), "/sara/api/pairs");
  assert.equal(cookieName("", "opencode_remote_session"), "opencode_remote_session");
  assert.equal(cookieName("/sara", "opencode_remote_session"), "opencode_remote_session_sara");
});

test("remote session partner links retain the selected root-domain host", () => {
  assert.equal(pairsHrefForBasePath("/sara"), "/pairs");
  assert.equal(pairsHrefForBasePath("/l390"), "/pairs?host=l390");
  assert.equal(pairsHrefForBasePath("/home"), "/pairs?host=home");
  assert.equal(pairsHrefForBasePath(""), "/pairs");
});

test("native interface uses the machine subdomain mapping", () => {
  const origins = {
    sara: "https://opencode-sara.sisihome.org",
    l390: "https://opencode-l390.sisihome.org",
    home: "https://opencode-home.sisihome.org",
  };
  assert.equal(machineForBasePath("/sara"), "sara");
  assert.equal(machineOrigin("/sara", "https://wrong.example"), origins.sara);
  assert.equal(machineOrigin("/l390", "https://wrong.example"), origins.l390);
  assert.equal(machineOrigin("/home", "https://wrong.example"), origins.home);
  assert.equal(machineOrigin("", "https://current.example"), "https://current.example");
});

test("prefixed native SPA links use machine origins and old prefixed URLs redirect with recomputed keys", () => {
  const id = "ses_a1b2";
  const encodedOrigin = (origin) => Buffer.from(origin).toString("base64url");
  const cases = [
    ["/sara", "https://opencode-sara.sisihome.org"],
    ["/l390", "https://opencode-l390.sisihome.org"],
    ["/home", "https://opencode-home.sisihome.org"],
  ];
  for (const [basePath, origin] of cases) {
    const expected = `${origin}/server/${encodedOrigin(origin)}/session/${id}`;
    assert.equal(nativeSessionUrl(origin, id), expected);
    assert.equal(prefixedNativeSessionRedirectTarget(basePath, `/server/old/session/${id}`), expected);
  }
  const saraOrigin = cases[0][1];
  assert.equal(prefixedNativeSessionRedirectTarget("/sara", `/server/old/session/${id}/part?x=1`), `${saraOrigin}/server/${encodedOrigin(saraOrigin)}/session/${id}/part?x=1`);
  assert.equal(prefixedNativeSessionRedirectTarget("", `/server/old/session/${id}`), undefined);
  assert.equal(prefixedNativeSessionRedirectTarget("/sara", "/remote-sessions"), undefined);
});

test("legacy aggregate remote URLs migrate to the shared-domain paths", () => {
  assert.equal(migrateRemoteUrl("https://opencode-sara.sisihome.org"), "https://opencode.sisihome.org/sara");
  assert.equal(migrateRemoteUrl("https://opencode-l390.sisihome.org/"), "https://opencode.sisihome.org/l390");
  assert.equal(migrateRemoteUrl("https://opencode-home.sisihome.org"), "https://opencode.sisihome.org/home");
  assert.equal(migrateRemoteUrl("https://opencode.sisihome.org/home"), "https://opencode.sisihome.org/home");
});

test("client base meta accepts only the allowlisted values", () => {
  const documentObject = (content) => ({ querySelector: () => ({ content }) });
  assert.equal(getBasePath(documentObject("/sara")), "/sara");
  assert.equal(getBasePath(documentObject("/evil")), "");
  assert.equal(getBasePath(documentObject("/sara/x")), "");
  assert.equal(getBasePath({ querySelector: () => null }), "");
});

test("compact shell preserves the legacy no-prefix output contract and prefixes owned paths", () => {
  const legacy = renderCompactShell("ses_test", "/workspace");
  assert.doesNotMatch(legacy, /opencode-base/);
  assert.match(legacy, /href="\/remote-sessions"/);
  assert.match(legacy, /src="\/c\/static\/compact\.js/);

  const prefixed = renderCompactShell("ses_test", "/workspace", "/sara");
  assert.match(prefixed, /meta name="opencode-base" content="\/sara"/);
  assert.match(prefixed, /href="\/sara\/remote-sessions"/);
  assert.match(prefixed, /src="\/sara\/c\/static\/compact\.js/);
  assert.doesNotMatch(prefixed, /href="\/remote-sessions"/);
  assert.doesNotMatch(prefixed, /src="\/c\/static\/compact\.js/);
});
