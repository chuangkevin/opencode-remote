import assert from "node:assert/strict";
import test from "node:test";

import {
  FORWARDED_PREFIXES,
  cookieName,
  isHubRequest,
  machineForBasePath,
  machineOrigin,
  prefixPath,
  requestBasePath,
} from "../dist/base-path.js";
import { getBasePath, migrateRemoteUrl } from "../static/pairs.js";
import { renderCompactShell } from "../dist/compact/shell.js";

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

test("native interface uses the machine subdomain mapping", () => {
  assert.equal(machineForBasePath("/sara"), "sara");
  assert.equal(machineOrigin("/sara", "https://wrong.example"), "https://opencode-sara.sisihome.org");
  assert.equal(machineOrigin("/l390", "https://wrong.example"), "https://opencode-l390.sisihome.org");
  assert.equal(machineOrigin("/home", "https://wrong.example"), "https://opencode.sisihome.org");
  assert.equal(machineOrigin("", "https://current.example"), "https://current.example");
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
