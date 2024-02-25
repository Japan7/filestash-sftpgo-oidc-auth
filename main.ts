import "https://deno.land/std@0.217.0/dotenv/load.ts";
import { decode } from "https://deno.land/x/djwt@v3.0.1/mod.ts";
import { logger } from "https://deno.land/x/hono@v4.0.7/middleware.ts";
import { Hono } from "https://deno.land/x/hono@v4.0.7/mod.ts";

const FILESTASH_URL = Deno.env.get("FILESTASH_URL")!;
const FILESTASH_API_KEY = Deno.env.get("FILESTASH_API_KEY")!;
const API_PREFIX = Deno.env.get("API_PREFIX")!;

const KEYCLOAK_URL = Deno.env.get("KEYCLOAK_URL")!;
const KEYCLOAK_REALM = Deno.env.get("KEYCLOAK_REALM")!;

const SFTPGO_WEB_URL = Deno.env.get("SFTPGO_WEB_URL")!;
const SFTPGO_ADMIN_BASICAUTH = Deno.env.get("SFTPGO_ADMIN_BASICAUTH")!;
const SFTPGO_KEYCLOAK_CLIENT_ID = Deno.env.get("SFTPGO_KEYCLOAK_CLIENT_ID")!;
const SFTPGO_KEYCLOAK_CLIENT_SECRET = Deno.env.get(
  "SFTPGO_KEYCLOAK_CLIENT_SECRET"
)!;

const SFTPGO_SFTP_HOST = Deno.env.get("SFTPGO_SFTP_HOST")!;
const SFTPGO_SFTP_PORT = Deno.env.get("SFTPGO_SFTP_PORT")!;
const PUBKEY_FILE = Deno.env.get("PUBKEY_FILE")!;
const PRIVKEY_FILE = Deno.env.get("PRIVKEY_FILE")!;

const PUBKEY = await Deno.readTextFile(PUBKEY_FILE);
const PRIVKEY = await Deno.readTextFile(PRIVKEY_FILE);

const BASE_OIDC_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect`;
const FILESTASH_REDIRECT_URI = `${FILESTASH_URL}${API_PREFIX}/callback`;

const app = new Hono();

app.use("*", logger());

app.get("/login", (c) => {
  return c.redirect(`${API_PREFIX}/login`, 301);
});

app.get(`${API_PREFIX}/login`, (c) => {
  const params = new URLSearchParams();
  params.append("client_id", SFTPGO_KEYCLOAK_CLIENT_ID);
  params.append("redirect_uri", FILESTASH_REDIRECT_URI);
  params.append("response_type", "code");
  params.append("scope", "openid");
  return c.redirect(`${BASE_OIDC_URL}/auth?${params}`);
});

app.get(`${API_PREFIX}/callback`, async (c) => {
  const accessToken = await getOIDCAccessToken(c.req.query("code")!);

  const [_header, _payload, _signature] = decode(accessToken);
  console.debug(_payload);
  const { preferred_username: username, groups: keycloak_groups } =
    _payload as { preferred_username: string; groups: string[] };

  const groups = keycloak_groups.map((g: string) => ({
    name: g.slice(1).replace("discord-", ""),
    type: 2,
  }));

  const apiToken = await createToken();
  const user = await findUser(apiToken, username);
  console.debug(user);

  if (!user) {
    await createUser(apiToken, username, groups);
  } else {
    await updateUser(apiToken, user, groups);
  }

  const setCookie = await createFilestashSession(username);
  c.res.headers.set("Set-Cookie", setCookie);
  return c.redirect("/");
});

async function getOIDCAccessToken(code: string) {
  const form = new URLSearchParams();
  form.append("client_id", SFTPGO_KEYCLOAK_CLIENT_ID);
  form.append("client_secret", SFTPGO_KEYCLOAK_CLIENT_SECRET);
  form.append("grant_type", "authorization_code");
  form.append("code", code);
  form.append("redirect_uri", FILESTASH_REDIRECT_URI);
  const resp = await fetch(`${BASE_OIDC_URL}/token`, {
    method: "POST",
    body: form,
  });
  const json = await resp.json();
  return json.access_token as string;
}

async function createToken() {
  const resp = await fetch(`${SFTPGO_WEB_URL}/api/v2/token`, {
    headers: { Authorization: `Basic ${SFTPGO_ADMIN_BASICAUTH}` },
  });
  const json = await resp.json();
  return json.access_token as string;
}

async function findUser(apiToken: string, username: string) {
  const resp = await fetch(
    `${SFTPGO_WEB_URL}/api/v2/users/${encodeURIComponent(username)}`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
    }
  );
  if (resp.ok) {
    return await resp.json();
  } else {
    return undefined;
  }
}

interface SFTPGoGroup {
  name: string;
  type: number;
}

async function createUser(
  apiToken: string,
  username: string,
  groups: SFTPGoGroup[]
) {
  const user = {
    status: 1,
    username,
    groups,
    permissions: {
      "/": ["list"],
    },
    public_keys: [PUBKEY],
  };

  const resp = await fetch(`${SFTPGO_WEB_URL}/api/v2/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify(user),
  });

  if (!resp.ok) {
    console.error(await resp.text());
  }
}

// deno-lint-ignore no-explicit-any
async function updateUser(apiToken: string, user: any, groups: SFTPGoGroup[]) {
  const public_keys = user.public_keys ?? [];
  if (!public_keys.includes(PUBKEY)) {
    public_keys.push(PUBKEY);
  }

  const payload = {
    ...user,
    status: 1,
    groups,
    public_keys,
  };

  const resp = await fetch(
    `${SFTPGO_WEB_URL}/api/v2/users/${encodeURIComponent(user.username)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(payload),
    }
  );

  if (!resp.ok) {
    console.error(await resp.text());
  }
}

async function createFilestashSession(username: string) {
  const params = new URLSearchParams();
  params.append("key", FILESTASH_API_KEY);
  const payload = {
    type: "sftp",
    hostname: SFTPGO_SFTP_HOST,
    port: SFTPGO_SFTP_PORT,
    username,
    password: PRIVKEY,
  };
  const resp = await fetch(`${FILESTASH_URL}/api/session?${params}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const setCookie = resp.headers.get("Set-Cookie")!;
  return setCookie;
}

Deno.serve(app.fetch);
